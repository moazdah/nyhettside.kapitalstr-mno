import { db } from '../db';
import { ensureRadarSchema, pruneRadarNoise } from '../radar/news-radar';

const MODEL = 'deepseek-flash';
const RULESET = 'radar-v3';
const MODEL_TAG = `${MODEL}/${RULESET}`;
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
  const attentionScore = Math.max(0, Math.min(100, Math.round(Number(item?.oppmerksomhet_score) || 0)));
  const numbersScore = Math.max(0, Math.min(100, Math.round(Number(item?.tall_score) || 0)));
  const attentionReason = String(item?.oppmerksomhet_begrunnelse || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!validIds.has(id) || !Number.isFinite(score) || !SECTIONS.has(section) || !TYPES.has(type) || !NEXT_STEPS.has(nextStep) || !reason) return null;
  return { id, score, section, type, nextStep, reason, creditRequired, attentionScore, numbersScore, attentionReason };
}

async function callDeepSeek(items) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY mangler i Vercel.');

  const system = `Du er nyhetsredaktør, finansjournalist og markedsanalytiker i Kapitalstrøm. Oppgaven er KUN å triagere oppdagede nyhetstreff. Ikke skriv artikler og ikke kopier formuleringer fra kildene.\n\nKapitalstrøm er en norsk finansavis, men radaren er GLOBAL. En sak trenger IKKE Norge-kobling for å være svært viktig. Store internasjonale selskaper, amerikanske/asiatiske/europeiske markeder, sentralbanker, råvarer og globale kapitalstrømmer kan være toppsaker.\n\nVurder hvert treff for redaksjonell prioritet på skala 0–100. Se særlig etter:\n- faktisk nyhetsverdi, ferskhet, overraskelse og hvor konkret hendelsen er\n- sannsynlig betydning for aksjer, renter, valuta, råvarer eller global/norsk økonomi\n- store selskapers resultater, omsetning, EPS, marginer, guiding, ordreinngang, cash flow og prognoser\n- om tallene ser ut til å gi grunnlag for en egen analyse av hva som slo forventningene, hva som endret seg og hva markedet kan bry seg om\n- oppkjøp, kapitalinnhenting, konkurser, restrukturering, regulatoriske vedtak, store kontrakter og ledelsesendringer\n- sentralbanker, inflasjon, jobbtall, PMI/GDP, olje/energi, shipping, krypto og store markedsbevegelser\n- legitim leserinteresse: kjente selskaper/personer, store summer, uventede vendinger, tydelige vinnere/tapere og saker folk faktisk vil klikke på fordi hendelsen er viktig eller oppsiktsvekkende\n\nOPPMERKSOMHET:\nGi også oppmerksomhet_score 0–100. Dette er IKKE en clickbait-score. Høy score betyr at saken sannsynligvis trekker ekte leserinteresse fordi den gjelder et kjent navn, stor sum, overraskende utvikling, kraftig bevegelse, konflikt med økonomisk betydning eller et tema mange investorer følger.\n- Høy oppmerksomhet uten finans-/økonomisk substans skal IKKE automatisk gi høy hovedscore.\n- En stor Nvidia-, Apple-, Microsoft-, Novo Nordisk-, JPMorgan-, olje-, Fed- eller lignende sak kan ha høy hovedscore selv uten Norge-kobling.\n\nTALL:\nGi tall_score 0–100 for hvor mye saken egner seg til tallanalyse.\n- 80–100: konkrete resultat-/guiding-/margin-/vekst-/markedsdata som bør analyseres\n- 50–79: flere relevante tall, men begrenset dybde\n- 1–49: enkelte tall eller nivåer\n- 0: i praksis ingen kvantitativ sak\nEt resultattreff fra et stort selskap med konkrete tall skal normalt behandles som en sterk kandidat, ikke bare som et vanlig nyhetstreff.\n\nVIKTIG:\n- Du får bare tittel, kort sammendrag og kildemetadata. Bruk KUN opplysninger som faktisk står i input.\n- Ikke fyll inn datoer, rentevedtak, kurser, beløp, sitater eller resultattall fra egen kunnskap.\n- En tittel kan i seg selv være konkret nok til 60+ hvis den tydelig beskriver en vesentlig hendelse, f.eks. at et stort selskap kutter guiding, slår forventninger, varsler oppkjøp eller aksjen stuper etter resultater. Neste steg kan fortsatt være finn_primarkilde.\n- Tynn metadata skal trekke ned sikkerheten, men skal ikke automatisk låse en åpenbart stor internasjonal hendelse under 60.\n- Vanlig politikk, valg, personkonflikter, kultur, reise, skole, kjendiser og sport er ikke Kapitalstrøm-saker i seg selv. Politikk er relevant når input eksplisitt beskriver økonomisk politikk, skatt/budsjett/regulering, handel, energi, renter/valuta eller konkret markedsreaksjon.\n- Kommentarstoff og generelle spådommer uten nye fakta skal normalt ikke over 55.\n- 90–100 krever en eksplisitt, konkret og svært stor hendelse eller et klart markedsbevegende resultat.\n\nAnalytikerråd og kursmål kan være relevante når analytikeren/meglerhuset er tydelig identifisert og rådet er markant. Slike saker skal normalt ha kreditering_kreves=true og neste_steg=krediter_kilden. Vanlige markedsnyheter fra andre medier brukes primært som discovery; finn original-/primærkilden når det er mulig.\n\nSkala hovedscore:\n90–100: breaking, svært markedsbevegende eller global toppsak\n75–89: svært relevant og bør prioriteres raskt\n60–74: god kandidat til egen Kapitalstrøm-sak\n40–59: relevant å overvåke / trenger mer substans\n0–39: støy, rutine eller for perifer\n\nVelg seksjon kun fra Markeder, Økonomi, Renter, Selskaper, Analyse.\nVelg type kun fra breaking, resultat, oppkjøp, kontrakt, makro, renter, analytikerraad, markedsbevegelse, regulatorisk, analyse, annet.\nVelg neste_steg kun fra finn_primarkilde, krediter_kilden, overvak, ignorer.\n\nReturner gyldig JSON nøyaktig på formen:\n{\"items\":[{\"id\":1,\"score\":86,\"oppmerksomhet_score\":91,\"tall_score\":88,\"seksjon\":\"Selskaper\",\"type\":\"resultat\",\"neste_steg\":\"finn_primarkilde\",\"kreditering_kreves\":false,\"begrunnelse\":\"Kort konkret begrunnelse\",\"oppmerksomhet_begrunnelse\":\"Hvorfor saken har legitim leserinteresse\"}]}\nTa med én rad per input-id.`;

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
      max_tokens: 2600,
      stream: false,
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`DeepSeek radar-scoring feilet: ${body?.error?.message || `HTTP ${response.status}`}`);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek svarte uten JSON-innhold for radaren.');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`DeepSeek svarte med ufullstendig/ugyldig JSON (${content.length} tegn). Batchen prøves separat ved neste kjøring.`);
  }

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
    WHERE ai_score IS NULL OR ai_model IS DISTINCT FROM ${MODEL_TAG}
    ORDER BY published_at DESC NULLS LAST, discovered_at DESC
    LIMIT ${Math.max(1, Math.min(40, Number(limit) || 30))}
  `;
  if (!pending.length) return { requested: 0, scored: 0, model: MODEL_TAG, estimatedCostUsd: 0 };

  const chunks = [];
  for (let i = 0; i < pending.length; i += 10) chunks.push(pending.slice(i, i + 10));

  let scored = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let estimatedCostUsd = 0;
  const errors = [];
  const batchResults = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    try {
      const result = await callDeepSeek(chunk);
      const validIds = new Set(chunk.map((r) => Number(r.id)));
      const normalized = result.items.map((x) => normalize(x, validIds)).filter(Boolean);

      let batchScored = 0;
      for (const item of normalized) {
        const updated = await sql`
          UPDATE radar_items
          SET ai_score = ${item.score},
              ai_section = ${item.section},
              ai_reason = ${item.reason},
              ai_model = ${MODEL_TAG},
              ai_scored_at = now(),
              candidate_type = ${item.type},
              credit_required = ${item.creditRequired},
              next_step = ${item.nextStep},
              attention_score = ${item.attentionScore},
              attention_reason = ${item.attentionReason || null},
              numbers_score = ${item.numbersScore}
          WHERE id = ${item.id}
            AND (ai_score IS NULL OR ai_model IS DISTINCT FROM ${MODEL_TAG})
          RETURNING id
        `;
        batchScored += updated.length;
      }

      const promptTokens = Number(result.usage.prompt_tokens || 0);
      const completionTokens = Number(result.usage.completion_tokens || 0);
      const batchCost = estimateCostUsd(result.usage);

      totalPromptTokens += promptTokens;
      totalCompletionTokens += completionTokens;
      estimatedCostUsd += batchCost;
      scored += batchScored;
      batchResults.push({ batch: index + 1, requested: chunk.length, scored: batchScored });
    } catch (error) {
      const message = error?.message || 'Ukjent feil';
      errors.push(`Batch ${index + 1}: ${message}`);
      batchResults.push({ batch: index + 1, requested: chunk.length, scored: 0, error: message });
    }
  }

  if (totalPromptTokens || totalCompletionTokens) {
    await sql`
      INSERT INTO ai_usage (steg, modell, tokens_inn, tokens_ut, kostnad_usd)
      VALUES ('radar-scoring', ${MODEL_TAG}, ${totalPromptTokens}, ${totalCompletionTokens}, ${estimatedCostUsd})
    `;
  }

  return {
    requested: pending.length,
    scored,
    model: MODEL_TAG,
    estimatedCostUsd,
    usage: {
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
    },
    errors,
    batches: batchResults,
  };
}
