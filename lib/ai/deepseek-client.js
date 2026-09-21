function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function cleanError(error) {
  const message = String(error?.message || error || 'ukjent feil').replace(/\s+/g, ' ').trim();
  return message.slice(0, 500);
}

export async function deepSeekJsonRequest({
  system,
  user,
  model = 'deepseek-flash',
  maxTokens = 3000,
  temperature = 0.1,
  thinking = false,
  reasoningEffort = 'high',
  timeoutMs = 45000,
  retries = 3,
  label = 'DeepSeek',
}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY mangler i Vercel.');

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const attemptMaxTokens = Math.min(
      8000,
      Math.max(maxTokens, Math.round(maxTokens * (1 + attempt * 0.35)))
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          thinking: { type: thinking ? 'enabled' : 'disabled' },
          ...(thinking ? { reasoning_effort: reasoningEffort } : { temperature }),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
          ],
          response_format: { type: 'json_object' },
          max_tokens: attemptMaxTokens,
          stream: false,
        }),
      });

      let body;
      try { body = await response.json(); } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) throw Object.assign(new Error('Provider response timed out'), { name: 'AbortError' });
        throw new Error(`${label}: Leverandøren svarte med ugyldig JSON (HTTP ${response.status}).`);
      }

      if (!response.ok) {
        const detail = body?.error?.message || `HTTP ${response.status}`;
        lastError = new Error(`${label}: ${detail}`);

        if (retryableStatus(response.status) && attempt < retries) {
          await sleep(900 * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      const choice = body?.choices?.[0];
      const finishReason = choice?.finish_reason;
      const content = choice?.message?.content;
      const outputTokens = Number(body?.usage?.completion_tokens || 0);
      if (finishReason === 'length') throw new Error(`${label}: AI-svaret ble avbrutt ved tokengrensen (${outputTokens} output tokens).`);
      if (!String(content || '').trim()) {
        lastError = new Error(`${label}: AI svarte uten JSON-innhold (finish_reason=${['stop','length','content_filter'].includes(finishReason) ? finishReason : 'unknown'}, output_tokens=${outputTokens}).`);
        if (attempt < retries) {
          await sleep(700 * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      try {
        const cleaned = String(content)
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/i, '');
        return {
          json: JSON.parse(cleaned),
          usage: body.usage || {},
          attempts: attempt + 1,
          finishReason: body?.choices?.[0]?.finish_reason || null,
        };
      } catch {
        const finishReason = body?.choices?.[0]?.finish_reason || null;
        lastError = new Error(
          `${label}: AI svarte med ugyldig/ufullstendig JSON (${content.length} tegn${finishReason ? `, finish_reason=${finishReason}` : ''}).`
        );
        if (attempt < retries) {
          await sleep(700 * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }
    } catch (error) {
      const normalized = error?.name === 'AbortError'
        ? new Error(`${label}: AI-kallet brukte mer enn ${Math.round(timeoutMs / 1000)} sekunder.`)
        : error;

      lastError = normalized;
      const isNetworkFailure = error?.name === 'AbortError'
        || /fetch failed|network|socket|ECONN|ETIMEDOUT|UND_ERR/i.test(String(error?.message || ''));

      if (isNetworkFailure && attempt < retries) {
        await sleep(900 * Math.pow(2, attempt));
        continue;
      }

      if (attempt < retries && /ugyldig\/ufullstendig JSON|uten JSON-innhold/i.test(String(normalized?.message || ''))) {
        await sleep(700 * Math.pow(2, attempt));
        continue;
      }

      throw new Error(cleanError(normalized));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(cleanError(lastError || new Error(`${label}: ukjent feil`)));
}
