import { db } from '../db';
import { ensureFactPackSchema } from '../research/fact-pack';
import { deepSeekJsonRequest } from './deepseek-client';

const MODEL = 'deepseek-flash';
const RULESET = 'article-v5';
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
      source_role TEXT,
      source_quality TEXT,
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
  await sql`ALTER TABLE article_provenance ADD COLUMN IF NOT EXISTS source_role TEXT`;
  await sql`ALTER TABLE article_provenance ADD COLUMN IF NOT EXISTS source_quality TEXT`;
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

function stripLinkUrls(value) {
  return String(value || '').replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1');
}

function extractNumericTokens(value) {
  const text = stripLinkUrls(value);
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

async function deepSeekJson(system, user, maxTokens = 3600, temperature = 0.18) {
  return deepSeekJsonRequest({
    system,
    user,
    model: MODEL,
    maxTokens,
    temperature,
    timeoutMs: 55000,
    retries: 3,
    label: 'DeepSeek artikkelmotor',
  });
}

function normalizeDraft(raw, fallbackSection) {
  const paragraphs = Array.isArray(raw?.paragraphs)
    ? raw.paragraphs
        .map((p) => String(p || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 18)
    : [];

  const requestedSection = String(raw?.section || '').trim();
  const section = SECTIONS.has(requestedSection)
    ? requestedSection
    : (SECTIONS.has(fallbackSection) ? fallbackSection : 'Markeder');

  return {
    title: String(raw?.title || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    dek: String(raw?.dek || '').replace(/\s+/g, ' ').trim().slice(0, 420),
    paragraphs,
    section,
    visualType: ['press_photo', 'official_photo', 'data_chart', 'none'].includes(raw?.visual_type)
      ? raw.visual_type
      : 'none',
    visualBrief: String(raw?.visual_brief || '').replace(/\s+/g, ' ').trim().slice(0, 500),
  };
}

async function writeArticle(item, pack) {
  const system = `Du er en erfaren norsk finansjournalist og økonom i Kapitalstrøm. Skriv et ORIGINALT nyhetsutkast på bokmål fra den strukturerte faktapakken.

Tenk som en journalist, ikke som en compliance-rapport. Velg struktur etter hendelsen; ikke bruk en fast mal.

SPRÅK OG JOURNALISTIKK:
- Gå raskt til det viktigste og forklar hvorfor saken er relevant.
- Skriv presist, levende og nøkternt. Varier setningslengde og avsnitt.
- Unngå AI-klisjeer, tomme oppsummeringer, overforklaring og mekaniske mellomtitler.
- Tittelen skal være konkret og informativ, uten clickbait.
- Dek/undertittel skal tilføre informasjon, ikke gjenta tittelen.
- Lengden bestemmes av faktamengden. Ikke fyll ut.
- Ingen punktlister eller interne redaksjonsnotater.
- Eneste tillatte markdown er kildehenvisninger i formen [Kildenavn](https://eksakt-url).

KILDER:
- Fakta i fact_pack er godkjent kildegrunnlag for dette utkastet.
- En faktapakke kan bygge på én sterk kilde. Du skal IKKE etterlyse flere kilder i artikkelen.
- Du skal ALDRI skrive formuleringer som "primærkilden bekrefter ikke", "faktapakken viser", "kilden kunne ikke verifiseres", "ifølge vår kontroll" eller annen intern kilde-/verifikasjonsspråk.
- Hvis et faktum har attribution_needed=true, attribuer det naturlig til source_name når MEDIET faktisk eier opplysningen, for eksempel et eget intervju, eksklusiv analyse eller eget avsløringsarbeid.
- Bruk provenance på hvert faktum:
  * original_statement: tilskriv personen/organisasjonen og origin_context.
  * original_document: tilskriv dokumentet/selskapet/institusjonen når det er naturlig.
  * exclusive_media_report: krediter mediet tydelig, fordi opplysningen faktisk kommer derfra.
  * secondary_report: bruk mediet bare hvis det er nødvendig for akkurat den opplysningen; ikke overkrediter.
- DIREKTE SITATER skal primært tilskrives speaker og origin_context, ikke discovery-mediet.
- Bruk aldri formuleringen "X bekrefter" om et medium som bare har omtalt en offentlig hendelse. Skriv hendelsen direkte og krediter original aktør/dokument der det er relevant.
- Et medium som bare videreformidler en uttalelse skal ikke fremstilles som om personen snakket med det mediet.
- Hvis attribution_needed=false, trenger du ikke gjenta kilden i hvert avsnitt.
- Hvis kildegrunnlaget er en offisiell institusjon eller selskap, kan du naturlig skrive "Bank of Japan opplyser ...", "Berkshire skriver ..." eller vise til det konkrete brevet/dokumentet der det passer.
- Ikke kopier formuleringer fra discovery-medier. Skriv selvstendig fra faktapakken.
- Discovery-kildens navn skal normalt IKKE nevnes i leserteksten når originalkilden allerede er funnet.
- Kreditering skal være presis, men sparsom: leseren skal ikke oppleve en kjede av "ifølge X" når faktagrunnlaget allerede er klart.
- Når provenance=exclusive_media_report eller en secondary_report faktisk MÅ krediteres, og fact.source_url finnes, gjør kilden klikkbar med nøyaktig denne syntaksen: [Kildenavn](source_url).
- Bruk source_url nøyaktig som den står i faktapakken. Aldri finn opp, forkort eller omskriv en URL.
- Ikke lag klikkbar mediehenvisning når original_statement/original_document allerede dekker opplysningen.
- Ikke finn opp sitater, markedsreaksjoner, kursbevegelser eller analytikervurderinger.
- Ikke bruk interne unknowns; de er med vilje IKKE tilgjengelige i input til deg.

RESULTATER OG TALL:
- Når fact_pack.analysis_signals.is_earnings=true, skal du skrive som en finansjournalist som faktisk leser regnskapet: prioriter de viktigste tallene, forklar vekst/marginer/guiding/segmenter og hvorfor de betyr noe.
- Ikke dump en liste med tall. Finn 2–4 hovedpoenger og bygg saken rundt dem.
- Hvis beats_misses inneholder eksplisitte forventninger, forklar hvilke nøkkeltall som slo/bommet og hvor. Hvis forventninger mangler, ikke dikt opp konsensus.
- Skill mellom sterk omsetningsvekst og svak lønnsomhet, mellom rapportert kvartal og fremtidig guiding, og mellom konserntall og segmenter når faktapakken gir grunnlag for det.
- Store resultatsaker kan være gode hovedsaker selv uten Norge-kobling.

MARKEDSEFFEKT:
- Forklar relevant markedseffekt når fact_pack.market_relevance gir grunnlag for det.
- Skill klart mellom dokumentert fakta og mulig effekt. Bruk "kan", "vil kunne" eller "isolert sett" når du beskriver scenarioer.
- Ikke gi Kapitalstrøms egne kjøp/salg-råd.
- Dersom et dokumentert råd kommer fra en ekstern analytiker/aktør, attribuer rådet tydelig til denne aktøren.

BILDE/GRAFIKK:
- Velg visual_type: press_photo, official_photo, data_chart eller none.
- Bruk data_chart når tall/utvikling er selve saken; ellers foreslå et ekte presse-/offisielt bilde.
- Aldri foreslå et generert bilde som skal fremstå som dokumentasjon av en virkelig hendelse.

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
    source_basis: {
      name: pack.primary_source_name,
      url: pack.primary_source_url,
      role: pack.source_role,
      quality: pack.source_quality,
    },
    fact_pack: {
      headline_fact: pack.headline_fact,
      event_type: pack.event_type,
      facts: pack.facts,
      numbers: pack.numbers,
      entities: pack.entities,
      market_relevance: pack.market_relevance,
      analysis_signals: pack.analysis_signals,
      confidence: pack.confidence,
    },
    editorial_context: {
      section: item.ai_section,
      score: item.ai_score,
      discovery_source_name: item.source_name,
      credit_required: item.credit_required,
    },
  };

  const result = await deepSeekJson(system, input, 3800, 0.2);
  return { draft: normalizeDraft(result.json, item.ai_section), usage: result.usage };
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
           fp.primary_source_name, fp.primary_source_url, fp.source_role, fp.source_quality,
           fp.headline_fact, fp.event_type, fp.facts, fp.numbers, fp.entities,
           fp.market_relevance, fp.analysis_signals, fp.can_write, fp.confidence
    FROM radar_items r
    JOIN fact_packs fp ON fp.radar_item_id = r.id
    WHERE r.id = ${Number(id)}
    LIMIT 1
  `;

  if (!row) throw new Error('Fant ikke radartreff med faktapakke.');
  if (row.fact_status !== 'ready' || row.can_write !== true || Number(row.confidence || 0) < 60) {
    throw new Error('Faktapakken er ikke klar for artikkelskriving.');
  }

  const [liveExisting] = await sql`
    SELECT id, slug
    FROM articles
    WHERE radar_item_id = ${row.radar_id} AND status = 'live'
    ORDER BY id DESC
    LIMIT 1
  `;

  const [existingDraft] = await sql`
    SELECT id, slug
    FROM articles
    WHERE radar_item_id = ${row.radar_id} AND status = 'draft'
    ORDER BY id DESC
    LIMIT 1
  `;

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
    source_role: row.source_role,
    source_quality: row.source_quality,
    headline_fact: row.headline_fact,
    event_type: row.event_type,
    facts: Array.isArray(row.facts) ? row.facts : [],
    numbers: Array.isArray(row.numbers) ? row.numbers : [],
    entities: Array.isArray(row.entities) ? row.entities : [],
    market_relevance: row.market_relevance,
    analysis_signals: row.analysis_signals && typeof row.analysis_signals === 'object' ? row.analysis_signals : {},
    confidence: Number(row.confidence || 0),
  };

  const generated = await writeArticle(item, pack);
  await logUsage(sql, 'article-write', generated.usage);

  const draft = generated.draft;
  if (!draft.title && !draft.dek && !draft.paragraphs.length) {
    throw new Error('AI svarte uten et brukbart artikkelutkast.');
  }

  const body = draft.paragraphs.length
    ? draft.paragraphs.join('\n\n')
    : (draft.dek || pack.headline_fact || 'Utkastet trenger redaksjonell bearbeiding.');

  const numeric = deterministicNumberCheck(draft, pack);
  const verificationStatus = numeric.pass ? 'pending_review' : 'warning';
  const tallValidert = numeric.pass;
  const validationNote = numeric.pass
    ? 'Utkast lagret. Automatisk tallkontroll mot faktapakken bestått. Redaksjonell kontroll gjenstår før publisering.'
    : `Utkast lagret med redaksjonell advarsel. Tall som bør kontrolleres: ${numeric.unsupported.join(', ')}.`;

  let article;

  if (existingDraft) {
    [article] = await sql`
      UPDATE articles
      SET tittel = ${draft.title || row.radar_title},
          undertittel = ${draft.dek || pack.headline_fact},
          brodtekst = ${body},
          seksjon = ${draft.section},
          ai_score = ${Number(row.ai_score || 0)},
          ai_begrunnelse = ${`Utkast fra faktapakke ${row.fact_version} (${row.confidence}/100).`},
          ai_modell = ${`${MODEL}/${RULESET}`},
          tall_validert = ${tallValidert},
          valideringsnotat = ${validationNote},
          kilde_url = ${row.primary_source_url},
          kilde_hentet = now(),
          fact_pack_id = ${row.fact_pack_id},
          created_at = now()
      WHERE id = ${existingDraft.id}
      RETURNING id, slug
    `;
  } else {
    let slug = slugify(draft.title || row.radar_title || 'utkast');
    const [slugExists] = await sql`SELECT id FROM articles WHERE slug = ${slug} LIMIT 1`;
    if (slugExists || liveExisting) slug = `${slug}-${row.radar_id}-utkast-${Date.now()}`;

    [article] = await sql`
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
  }

  await sql`
    INSERT INTO article_provenance (
      article_id, radar_item_id, fact_pack_id, fact_pack_version,
      discovery_source_name, discovery_url, primary_source_name, primary_source_url,
      source_role, source_quality, credit_required, generation_model, generation_ruleset,
      verification_status, verification_confidence, verification_details,
      visual_type, visual_brief, updated_at
    )
    VALUES (
      ${article.id}, ${row.radar_id}, ${row.fact_pack_id}, ${row.fact_version},
      ${row.source_name}, ${row.discovery_url}, ${row.primary_source_name}, ${row.primary_source_url},
      ${row.source_role}, ${row.source_quality}, ${Boolean(row.credit_required)}, ${MODEL}, ${RULESET},
      ${verificationStatus}, 0, ${JSON.stringify({ numeric })}::jsonb,
      ${draft.visualType}, ${draft.visualBrief}, now()
    )
    ON CONFLICT (article_id) DO UPDATE SET
      fact_pack_id = EXCLUDED.fact_pack_id,
      fact_pack_version = EXCLUDED.fact_pack_version,
      discovery_source_name = EXCLUDED.discovery_source_name,
      discovery_url = EXCLUDED.discovery_url,
      primary_source_name = EXCLUDED.primary_source_name,
      primary_source_url = EXCLUDED.primary_source_url,
      source_role = EXCLUDED.source_role,
      source_quality = EXCLUDED.source_quality,
      credit_required = EXCLUDED.credit_required,
      generation_model = EXCLUDED.generation_model,
      generation_ruleset = EXCLUDED.generation_ruleset,
      verification_status = EXCLUDED.verification_status,
      verification_confidence = EXCLUDED.verification_confidence,
      verification_details = EXCLUDED.verification_details,
      visual_type = EXCLUDED.visual_type,
      visual_brief = EXCLUDED.visual_brief,
      updated_at = now()
  `;

  return {
    ok: true,
    status: existingDraft ? 'regenerated' : 'draft',
    articleId: article.id,
    slug: article.slug,
    verificationStatus,
    verificationConfidence: 0,
    tallValidert,
    title: draft.title || row.radar_title,
  };
}
