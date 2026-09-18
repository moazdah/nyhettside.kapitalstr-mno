import { db } from '../db';
import { ensureFactPackSchema } from '../research/fact-pack';

const MODEL = 'deepseek-flash';
const RULESET = 'article-v1';
const SECTIONS = new Set(['Markeder', 'Økonomi', 'Renter', 'Selskaper', 'Analyse']);

function estimateCostUsd(usage = {}) {
  const hit = Number(usage.prompt_cache_hit_tokens || 0);
  const miss = Number(usage.prompt_cache_miss_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens || 0);
  return ((hit * 0.003) + (miss * 0.15) + (output * 0.6)) / 1_000_000;
}

export async function ensureArticleWriterSchema(sql = db()) {
  await ensureFactPackSchema(sql);
  await sql`ALTER TABLE articles ADD COLUMN IF NOT EXISTS radar_item_id BIGINT`;
  await sql`ALTER TABLE articles ADD COLUMN IF NOT EXISTS fact_pack_id BIGINT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_articles_radar_item ON articles (radar_item_id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS article_provenance (
      article_id BIGINT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
      radar_item_id BIGINT REFERENCES radar_items(id) ON DELETE SET NULL,
      fact_pack_id BIGINT REFERENCES fact_packs(id) ON DELETE SET NULL,
      fact_pack_version TEXT,
      discovery_source_name TEXT,
      discovery_url TEXT,
      primary_source_name TEXT,
      primary_source_url TEXT,
      credit_required BOOLEAN DEFAULT FALSE,
      generation_model TEXT,
      generation_ruleset TEXT,
      verification_status TEXT,
      verification_confidence INT,
      verification_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      visual_type TEXT,
      visual_brief TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

function slugify(value) {
  const base = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || `sak-${Date.now()}`;
}

function textOfArticle(article) {
  return [article.title, article.dek, ...(article.paragraphs || [])].filter(Boolean).join('\n');
}

function extractNumericTokens(value) {
  const text = String(value || '');
  const matches = text.match(/(?<![A-Za-zÆØÅæøå])\d+(?:[ .]\d{3})*(?:[,.]\d+)?%?/g) || [];
  return matches.map((raw) => ({
    raw,
    normalized: raw.replace(/\s/g, '').replace(',', '.').replace(/%$/, ''),
  }));
}

function allowedNumberSet(pack) {
  const corpus = JSON.stringify({
    headline: pack.headline_fact,
    facts: pack.facts,
    numbers: pack.numbers,
    unknowns: pack.unknowns,
    market_relevance: pack.market_relevance,
  });
  return new Set(extractNumericTokens(corpus).map((x) => x.normalized));
}

function deterministicNumberCheck(article, pack) {
  const allowed = allowedNumberSet(pack);
  const used = extractNumericTokens(textOfArticle(article));
  const unsupported = [];
  for (const token of used) {
    if (!allowed.has(token.normalized)) unsupported.push(token.raw);
  }
  return {
    pass: unsupported.length === 0,
    unsupported: [...new Set(unsupported)],
    used: [...new Set(used.map((x) => x.raw))],
  };
}

async function deepSeekJson(system, user, maxTokens = 3200, temperature = 0.15) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY mangler i Vercel.');

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
        { role: 'user', content: JSON.stringify(user) },
      ],
      response_format: { type: 'json_object' },
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`DeepSeek artikkelmotor feilet: ${body?.error?.message || `HTTP ${response.status}`}`);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek svarte uten JSON.');
  return { json: JSON.parse(content), usage: body.usage || {} };
}

function normalizeDraft(raw, fallbackSection) {
  const paragraphs = Array.isArray(raw?.paragraphs)
    ? raw.paragraphs.map((p) => String(p || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 16)
    : [];
  const section = SECTIONS.has(String(raw?.section || '').trim()) ? String(raw.section).trim() : fallbackSection;
  return {
    title: String(raw?.title || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    dek: String(raw?.dek || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    paragraphs,
    section: SECTIONS.has(section) ? section : 'Markeder',
    visualType: ['press_photo', 'official_photo', 'data_chart', 'none'].includes(raw?.visual_type) ? raw.visual_type : 'none',
    visualBrief: String(raw?.visual_brief || '').replace(/\s+/g, ' ').trim().slice(0, 500),
  };
}

async function writeArticle(item, pack) {
  const system = `Du er en erfaren norsk finansjournalist og økonom i Kapitalstrøm. Skriv et ORIGINALT nyhetsutkast på bokmål fra den strukturerte faktapakken.

Dette er journalistikk, ikke en tekstmal. Før du skriver skal du forstå hvilken hendelse dette er og velge den mest naturlige strukturen for akkurat saken.

REDAKSJONELLE KRAV:
- Gå raskt til det viktigste. Første avsnitt skal gjøre klart hva som har skjedd og hvorfor det er relevant.
- Prioriter det mest nyhetsverdige fremfor kronologisk referat.
- Skriv presist, konkret og menneskelig. Varier setningslengde. Unngå generiske AI-formuleringer, oppsummerende tomprat og stive mellomtitler.
- Ikke bruk en fast "Hva betyr dette?"-mal. Markedsbetydning flettes inn der den naturlig hører hjemme.
- Bruk KUN dokumenterte fakta og tall i faktapakken. Radaroverskrift og discovery-sammendrag er IKKE faktakilder.
- Ikke finn opp sitater. I denne første versjonen skal du ikke bruke direkte sitater.
- Ikke finn opp markedsreaksjoner, kursbevegelser eller analytikervurderinger.
- Du kan forklare mulig markedsmessig betydning når faktapakken har market_relevance, men bruk tydelig betinget språk: "kan", "vil kunne", "isolert sett". Ikke presenter et scenario som observert fakta.
- Ikke gi Kapitalstrøms egne kjøp/salg-råd. Hvis saken senere gjelder et dokumentert analytikerråd, skal rådet attribueres til den eksterne aktøren.
- Ikke kopier eller parafraser discovery-mediets formuleringer. Skriv fra primærfakta.
- Kildetilknytning skal være naturlig: bruk formuleringer som "Bank of Japan opplyser..." der det er journalistisk relevant, uten å gjenta kilden i hvert avsnitt.
- Tittel: nøktern, konkret og informativ; ikke clickbait.
- Dek/undertittel: ett kort avsnitt som tilfører verdi, ikke gjentar tittelen.
- Lengden skal tilpasses stoffmengden. Ikke fyll ut for å nå en bestemt lengde.
- Ingen markdown, punktlister eller mellomtitler i brødteksten i denne første versjonen.

BILDE/GRAFIKK:
- Velg visual_type: press_photo, official_photo, data_chart eller none.
- Foreslå data_chart når tall/utvikling er selve saken; ellers et ekte dokumentarisk/offisielt bilde. Aldri foreslå et generert nyhetsfoto.

Returner kun JSON:
{
  "title":"...",
  "dek":"...",
  "section":"Renter",
  "paragraphs":["...","..."],
  "visual_type":"data_chart",
  "visual_brief":"kort redaksjonelt bilde-/grafikkforslag"
}`;

  const input = {
    primary_source: {
      name: pack.primary_source_name,
      url: pack.primary_source_url,
    },
    fact_pack: {
      headline_fact: pack.headline_fact,
      event_type: pack.event_type,
      facts: pack.facts,
      numbers: pack.numbers,
      entities: pack.entities,
      unknowns: pack.unknowns,
      market_relevance: pack.market_relevance,
      confidence: pack.confidence,
    },
    editorial_context: {
      section: item.ai_section,
      score: item.ai_score,
      credit_required: item.credit_required,
      discovery_source_name: item.source_name,
    },
  };

  const result = await deepSeekJson(system, input, 3600, 0.18);
  return { draft: normalizeDraft(result.json, item.ai_section), usage: result.usage };
}

async function verifyArticle(article, item, pack) {
  const system = `Du er faktasjekker i Kapitalstrøm. Kontroller et generert nyhetsutkast strengt mot faktapakken.

REGLER:
- Faktapakken er eneste tillatte faktagrunnlag.
- Discovery-overskrift/-kilde er ikke dokumentasjon.
- Marker enhver konkret faktapåstand som ikke støttes av faktapakken.
- Skill mellom fakta og forsiktig formulert analyse/scenario. "Kan" eller "vil kunne" kan være akseptabelt når det er en rimelig forklaring av market_relevance.
- Tall, prosenter, datoer, stemmetall og nivåer må være støttet.
- Ingen oppdiktede sitater eller observerte markedsreaksjoner.
- Ingen egne kjøp/salg-anbefalinger.
- pass=true bare hvis utkastet kan legges i menneskelig redaksjonskø uten kjent faktabrudd.

Returner kun JSON:
{
  "pass":true,
  "confidence":95,
  "unsupported_claims":[],
  "number_issues":[],
  "notes":"kort faktasjekk"
}`;

  const result = await deepSeekJson(system, {
    article,
    fact_pack: {
      headline_fact: pack.headline_fact,
      facts: pack.facts,
      numbers: pack.numbers,
      entities: pack.entities,
      unknowns: pack.unknowns,
      market_relevance: pack.market_relevance,
      primary_source_name: pack.primary_source_name,
    },
  }, 2200, 0);

  const raw = result.json || {};
  return {
    check: {
      pass: raw.pass === true,
      confidence: Math.max(0, Math.min(100, Math.round(Number(raw.confidence) || 0))),
      unsupportedClaims: Array.isArray(raw.unsupported_claims) ? raw.unsupported_claims.slice(0, 20).map(String) : [],
      numberIssues: Array.isArray(raw.number_issues) ? raw.number_issues.slice(0, 20).map(String) : [],
      notes: String(raw.notes || '').slice(0, 1000),
    },
    usage: result.usage,
  };
}

async function logUsage(sql, step, usage) {
  const tokensIn = Number(usage?.prompt_tokens || 0);
  const tokensOut = Number(usage?.completion_tokens || 0);
  const cost = estimateCostUsd(usage);
  await sql`
    INSERT INTO ai_usage (steg, modell, tokens_inn, tokens_ut, kostnad_usd)
    VALUES (${step}, ${MODEL}, ${tokensIn}, ${tokensOut}, ${cost})
  `;
}

export async function generateArticleDraftFromRadar(id) {
  const sql = db();
  await ensureArticleWriterSchema(sql);

  const [row] = await sql`
    SELECT r.id AS radar_id, r.title AS radar_title, r.source_name, r.url AS discovery_url,
           r.ai_score, r.ai_section, r.credit_required,
           fp.id AS fact_pack_id, fp.status AS fact_status, fp.version AS fact_version,
           fp.primary_source_name, fp.primary_source_url, fp.headline_fact, fp.event_type,
           fp.facts, fp.numbers, fp.entities, fp.unknowns, fp.market_relevance,
           fp.can_write, fp.confidence
    FROM radar_items r
    JOIN fact_packs fp ON fp.radar_item_id = r.id
    WHERE r.id = ${Number(id)}
    LIMIT 1
  `;

  if (!row) throw new Error('Fant ikke radartreff med faktapakke.');
  if (row.fact_status !== 'ready' || row.can_write !== true || Number(row.confidence || 0) < 70) {
    throw new Error('Faktapakken er ikke klar for artikkelskriving.');
  }

  const [existing] = await sql`
    SELECT id, slug, status
    FROM articles
    WHERE radar_item_id = ${row.radar_id}
      AND status IN ('draft', 'live')
    ORDER BY id DESC
    LIMIT 1
  `;
  if (existing) {
    return { ok: true, status: 'existing', articleId: existing.id, slug: existing.slug };
  }

  const item = {
    id: row.radar_id,
    ai_score: row.ai_score,
    ai_section: row.ai_section,
    credit_required: row.credit_required,
    source_name: row.source_name,
  };
  const pack = {
    primary_source_name: row.primary_source_name,
    primary_source_url: row.primary_source_url,
    headline_fact: row.headline_fact,
    event_type: row.event_type,
    facts: Array.isArray(row.facts) ? row.facts : [],
    numbers: Array.isArray(row.numbers) ? row.numbers : [],
    entities: Array.isArray(row.entities) ? row.entities : [],
    unknowns: Array.isArray(row.unknowns) ? row.unknowns : [],
    market_relevance: row.market_relevance,
    confidence: Number(row.confidence || 0),
  };

  const generated = await writeArticle(item, pack);
  await logUsage(sql, 'article-write', generated.usage);

  const draft = generated.draft;
  if (!draft.title && !draft.dek && !draft.paragraphs.length) {
    throw new Error('AI svarte uten et brukbart artikkelutkast.');
  }

  let slug = slugify(draft.title || row.radar_title || 'utkast');
  const [slugExists] = await sql`SELECT id FROM articles WHERE slug = ${slug} LIMIT 1`;
  if (slugExists) slug = `${slug}-${row.radar_id}`;

  const body = draft.paragraphs.length
    ? draft.paragraphs.join('\n\n')
    : (draft.dek || pack.headline_fact || 'Utkastet trenger redaksjonell bearbeiding.');

  const numeric = deterministicNumberCheck(draft, pack);
  let verification = {
    pass: false,
    confidence: 0,
    unsupportedClaims: [],
    numberIssues: [],
    notes: 'Faktasjekken er ikke kjørt ennå.',
  };
  let verificationStatus = numeric.pass ? 'pending' : 'warning';
  let verificationError = null;

  try {
    const verified = await verifyArticle(draft, item, pack);
    await logUsage(sql, 'article-verify', verified.usage);
    verification = verified.check;
    verificationStatus = numeric.pass
      && verification.pass
      && verification.unsupportedClaims.length === 0
      && verification.numberIssues.length === 0
        ? 'passed'
        : 'warning';
  } catch (error) {
    verificationError = error?.message || 'Ukjent feil i automatisk faktasjekk.';
    verificationStatus = 'verification_error';
  }

  const tallValidert = numeric.pass
    && verificationStatus === 'passed';

  const warnings = [];
  if (!numeric.pass) warnings.push(`Uverifiserte tall: ${numeric.unsupported.join(', ')}`);
  if (verification.unsupportedClaims.length) warnings.push(`Påstander til kontroll: ${verification.unsupportedClaims.join(' | ')}`);
  if (verification.numberIssues.length) warnings.push(`Tallmerknader: ${verification.numberIssues.join(' | ')}`);
  if (verificationError) warnings.push(`Automatisk faktasjekk feilet: ${verificationError}`);

  const validationNote = tallValidert
    ? `Automatisk kontroll bestått: tall støttes av faktapakken og AI-faktasjekk ${verification.confidence}/100. Menneskelig redaktør godkjenner før publisering.`
    : `Utkast lagret med redaksjonell advarsel. ${warnings.join(' ')} Menneskelig redaktør må kontrollere før publisering.`;

  const [article] = await sql`
    INSERT INTO articles (
      slug, status, tittel, undertittel, brodtekst, seksjon, forfatter,
      ai_score, ai_begrunnelse, ai_modell, tall_validert, valideringsnotat,
      kilde_url, kilde_hentet, radar_item_id, fact_pack_id, created_at
    )
    VALUES (
      ${slug}, 'draft', ${draft.title || row.radar_title}, ${draft.dek || pack.headline_fact}, ${body},
      ${draft.section}, 'Kapitalstrøm',
      ${Number(row.ai_score || 0)}, ${`Utkast fra faktapakke ${row.fact_version} (${row.confidence}/100).`},
      ${`${MODEL}/${RULESET}`}, ${tallValidert}, ${validationNote},
      ${row.primary_source_url}, now(), ${row.radar_id}, ${row.fact_pack_id}, now()
    )
    RETURNING id, slug
  `;

  await sql`
    INSERT INTO article_provenance (
      article_id, radar_item_id, fact_pack_id, fact_pack_version,
      discovery_source_name, discovery_url, primary_source_name, primary_source_url,
      credit_required, generation_model, generation_ruleset,
      verification_status, verification_confidence, verification_details,
      visual_type, visual_brief, updated_at
    )
    VALUES (
      ${article.id}, ${row.radar_id}, ${row.fact_pack_id}, ${row.fact_version},
      ${row.source_name}, ${row.discovery_url}, ${row.primary_source_name}, ${row.primary_source_url},
      ${Boolean(row.credit_required)}, ${MODEL}, ${RULESET},
      ${verificationStatus}, ${verification.confidence},
      ${JSON.stringify({ numeric, ai: verification, error: verificationError })}::jsonb,
      ${draft.visualType}, ${draft.visualBrief}, now()
    )
  `;

  return {
    ok: true,
    status: 'draft',
    articleId: article.id,
    slug: article.slug,
    verificationStatus,
    verificationConfidence: verification.confidence,
    tallValidert,
    title: draft.title || row.radar_title,
  };
}
