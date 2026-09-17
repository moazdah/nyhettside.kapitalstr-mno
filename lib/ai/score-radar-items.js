import { db } from '../db';
import { ensureRadarSchema, pruneRadarNoise } from '../radar/news-radar';

const MODEL = 'deepseek-flash';
const SECTIONS = new Set(['Markeder', 'Økonomi', 'Renter', 'Selskaper', 'Analyse']);
const TYPES = new Set(['breaking', 'resultat', 'oppkjøp', 'kontrakt', 'makro', 'renter', 'analytikerraad', 'markedsbevegelse', 'regulatorisk', 'analyse', 'annet']);
const NEXT_STEPS = new Set(['finn_primarkilde', 'krediter_kilden', 'overvak', 'ignorer']);

function estimateCostUsd(usage = {}) {
  const hit = Number(usage.prompt_cache_hit_tokens || 0);
  const miss = Number(usage.prompt_cache_miss_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens || 0);
  return ((hit * 0.003) + (miss * 0.15) + (output * 0.6)) / 1_000_000;
}

function normalize(item, validIds) {
  const id = Number(item?.id);
  const score = Math.max(0, Math.min(100, Math.round(Number(item?.score))));
  const section = String(item?.seksjon || '').trim();
  const type = String(item?.type || '').trim();
  const nextStep = String(item?.neste_steg || '').trim();
  const reason = String(item?.begrunnelse || '').replace(/\s+/g, ' ').trim().slice(0, 320);
  const creditRequired = Boolean(item?.kreditering_kreves);
  if (!validIds.has(id) || !Number.isFinite(score) || !SECTIONS.has(section) || !TYPES.has(type) || !NEXT_STEPS.has(nextStep) || !reason) return null;
  return { id, score, section, type, nextStep, reason, creditRequired };
}

async function callDeepSeek(items) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY mangler i Vercel.');

  const system = `Du er nyhetsredaktør og økonom i Kapitalstrøm. Oppgaven er KUN å triagere oppdagede nyhetstreff. Ikke skriv artikler og ikke kopier formuleringer fra kildene.

Vurder hvert treff for en norsk finansavis på skala 0–100. Se særlig etter:
- faktisk nyhetsverdi, nyhetens ferskhet og hvor uventet den er
- sannsynlig påvirkning på aksjer, renter, valuta, råvarer eller norsk økonomi
- om hendelsen har direkte relevans for Norge/Norden eller stor indirekte markedsbetydning
- om det er mulig å finne en primærkilde som bør brukes før publisering
- resultater/guiding, oppkjøp, kapitalinnhenting, store kontrakter, regulatoriske vedtak, rentebeslutninger, inflasjon/arbeidsmarked, olje/energi, shipping og vesentlige analytikerendringer

VIKTIG: Vanlig politikk, kultur, reise, skole, kjendiser, sport og generell samfunnsdebatt er ikke Kapitalstrøm-saker med mindre treffet har en konkret og vesentlig økonomisk eller markedsmessig konsekvens. Ikke gi høy score bare fordi tittelen inneholder ordet økonomi eller penger.

Analytikerråd og kursmål kan være relevante, særlig når analytikeren/meglerhuset har høy troverdighet eller synet er markant. Slike saker skal normalt ha kreditering_kreves=true og neste_steg=krediter_kilden. Vanlige markedsnyheter fra andre medier skal helst brukes som discovery: finn primærkilden og skriv selvstendig.

Skala:
90–100: breaking eller klart markedsbevegende
75–89: svært relevant, bør prioriteres raskt
60–74: god kandidat til egen Kapitalstrøm-sak
40–59: relevant å overvåke, men normalt ikke egen sak ennå
0–39: støy, rutine eller for perifer

Velg seksjon kun fra Markeder, Økonomi, Renter, Selskaper, Analyse.
Velg type kun fra breaking, resultat, oppkjøp, kontrakt, makro, renter, analytikerraad, markedsbevegelse, regulatorisk, analyse, annet.
Velg neste_steg kun fra finn_primarkilde, krediter_kilden, overvak, ignorer.

Sett kreditering_kreves=true når selve nyhetsverdien ser ut til å være et annet mediums unike opplysning, intervju, eksklusivitet, analytikerråd, sitat eller kommentar som ikke uten videre kan erstattes av en primærkilde. Dette er bare et redaksjonelt varsel; endelig kildevurdering skjer senere.

Returner gyldig JSON nøyaktig på formen {"items":[{"id":1,"score":78,"seksjon":"Selskaper","type":"analytikerraad","neste_steg":"krediter_kilden","kreditering_kreves":true,"begrunnelse":"Kort, konkret begrunnelse"}]}. Ta med én rad per input-id.`;

  const payload = items.map((i) => ({
    id: Number(i.id),
    tittel: i.title,
    sammendrag: String(i.summary || '').slice(0, 500),
    kilde: i.source_name,
    domene: i.source_domain,
    publisert: i.published_at,
  }));

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Vurder disse radartreffene:\n${JSON.stringify(payload)}` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.15,
      max_tokens: 3200,
      stream: false,
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`DeepSeek radar-scoring feilet: ${body?.error?.message || `HTTP ${response.status}`}`);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek svarte uten JSON-innhold for radaren.');
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed?.items)) throw new Error('DeepSeek svarte med uventet radar-format.');
  return { items: parsed.items, usage: body.usage || {} };
}

export async function scorePendingRadarItems(limit = 30) {
  const sql = db();
  await ensureRadarSchema(sql);
  await pruneRadarNoise(sql);
  const pending = await sql`
    SELECT id, title, summary, source_name, source_domain, published_at
    FROM radar_items
    WHERE ai_score IS NULL
    ORDER BY published_at DESC NULLS LAST, discovered_at DESC
    LIMIT ${Math.max(1, Math.min(40, Number(limit) || 30))}
  `;
  if (!pending.length) return { requested: 0, scored: 0, model: MODEL, estimatedCostUsd: 0 };

  const result = await callDeepSeek(pending);
  const validIds = new Set(pending.map((r) => Number(r.id)));
  const normalized = result.items.map((x) => normalize(x, validIds)).filter(Boolean);

  let scored = 0;
  for (const item of normalized) {
    const updated = await sql`
      UPDATE radar_items
      SET ai_score = ${item.score},
          ai_section = ${item.section},
          ai_reason = ${item.reason},
          ai_model = ${MODEL},
          ai_scored_at = now(),
          candidate_type = ${item.type},
          credit_required = ${item.creditRequired},
          next_step = ${item.nextStep}
      WHERE id = ${item.id} AND ai_score IS NULL
      RETURNING id
    `;
    scored += updated.length;
  }

  const tokensIn = Number(result.usage.prompt_tokens || 0);
  const tokensOut = Number(result.usage.completion_tokens || 0);
  const estimatedCostUsd = estimateCostUsd(result.usage);
  await sql`
    INSERT INTO ai_usage (steg, modell, tokens_inn, tokens_ut, kostnad_usd)
    VALUES ('radar-scoring', ${MODEL}, ${tokensIn}, ${tokensOut}, ${estimatedCostUsd})
  `;

  return { requested: pending.length, scored, model: MODEL, estimatedCostUsd, usage: result.usage };
}
