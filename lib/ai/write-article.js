import { db } from '../db';
import { ensureFactPackSchema } from '../research/fact-pack';
import { deepSeekJsonRequest } from './deepseek-client';

const MODEL = 'deepseek-v4-pro';
const RULESET = 'article-v6';
const SECTIONS = new Set(['Markeder', 'Økonomi', 'Renter', 'Selskaper', 'Analyse']);

function estimateCostUsd(usage = {}) {
  const hit = Number(usage.prompt_cache_hit_tokens || 0);
  const miss = Number(usage.prompt_cache_miss_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens || 0);

  // DeepSeek V4 Pro pricing as of 2026-09:
  // peak M-F 01-04 & 06-10 UTC, otherwise off-peak at half price.
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  const peak = weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const hitRate = peak ? 0.044 : 0.022;
  const missRate = peak ? 1.32 : 0.66;
  const outputRate = peak ? 3.96 : 1.98;

  return ((hit * hitRate) + (miss * missRate) + (output * outputRate)) / 1_000_000;
}

export async function ensureArticleWriterSchema(sql = db()) {
  await ensureFactPackSchema(sql);
  await sql`ALTER TABLE articles ADD COLUMN IF NOT EXISTS radar_item_id BIGINT`;
  await sql`ALTER TABLE articles ADD COLUMN IF NOT EXISTS fact_pack_id BIGINT`;
  await sql`ALTER TABLE articles ADD COLUMN IF NOT EXISTS pinned_source TEXT`;
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
  return [article.title, article.dek, ...(article.paragraphs || []), article.aiAnalysis].filter(Boolean).join('\n');
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

async function deepSeekJson(system, user, maxTokens = 6000) {
  return deepSeekJsonRequest({
    system,
    user,
    model: MODEL,
    maxTokens,
    thinking: true,
    reasoningEffort: 'high',
    timeoutMs: 60000,
    retries: 1,
    label: 'DeepSeek V4 Pro artikkelmotor',
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
    aiAnalysis: String(raw?.ai_analysis || '').replace(/\s+/g, ' ').trim().slice(0, 2200),
    qualityScore: Math.max(0, Math.min(100, Math.round(Number(raw?.quality_score || 0)))),
    qualityReason: String(raw?.quality_reason || '').replace(/\s+/g, ' ').trim().slice(0, 500),
  };
}

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function articleDepthCheck(draft, item, pack) {
  const factDensity = (pack.facts?.length || 0) + (pack.numbers?.length || 0);
  const targetWords = Number(item.ai_score || 0) >= 80 && factDensity >= 6
    ? 480
    : factDensity >= 4
      ? 340
      : 240;
  const articleWords = wordCount([draft.dek, ...(draft.paragraphs || []), draft.aiAnalysis].join(' '));
  const analysisWords = wordCount(draft.aiAnalysis);
  const pass = Boolean(draft.title)
    && Boolean(draft.dek)
    && (draft.paragraphs || []).length >= 4
    && articleWords >= targetWords
    && analysisWords >= 55
    && draft.qualityScore >= 65;

  return { pass, targetWords, articleWords, analysisWords, factDensity };
}

async function writeArticle(item, pack, previousDraft = null) {
  const system = `Du er Kapitalstrøms AI-journalist: en erfaren norsk finansjournalist, økonom og markedsanalytiker. Du skriver ORIGINAL journalistikk på bokmål fra en kontrollert faktapakke.

Du skal ikke høres ut som en oppsummeringsbot. Du skal gjøre redaksjonelle valg: identifisere hva som faktisk er nyheten, hvilke tall eller signaler som betyr mest, hva som er overraskende, hva som er svakt i aktørens eget narrativ, og hva en økonomisk interessert leser bør forstå etter å ha lest saken.

SKILL MELLOM FAKTA OG DIN EGEN VURDERING:
- Dokumenterte fakta kan skrives som vanlig nyhetstekst.
- Du HAR lov til å trekke egne økonomiske slutninger, vurdere styrke/svakhet, peke på sannsynlige konsekvenser og si hva du mener er det viktigste ved saken.
- Egne slutninger må bygge logisk på faktapakken og skal aldri introdusere nye tall, hendelser, sitater eller markedsbevegelser.
- Legg din tydeligste selvstendige vurdering i feltet ai_analysis. Leseren vil få dette merket som «AI-vurdering».
- ai_analysis skal være konkret og gjerne tydelig. Unngå meningsløse formuleringer som «dette kan være relevant for investorer».
- Du kan skrive at noe ser aggressivt, svakt, sterkt, defensivt, lite overbevisende eller viktig ut dersom du forklarer hvorfor ut fra dokumenterte fakta.
- Ikke gi personlige kjøp/salg-anbefalinger eller dikt opp kursmål.

JOURNALISTISK DYBDE:
- Led med nyheten, men stopp ikke ved den.
- Forklar mekanismen: hvorfor skjedde dette, hva endrer det, og hvilke deler av markedet/selskapet påvirkes?
- Sett tall i sammenheng med hverandre. Ikke bare list dem.
- Finn konflikt/spenning når den finnes: forventning mot utfall, vekst mot margin, renteheving mot svakere valuta, ledelsens budskap mot dokumenterte tall.
- Ta med relevant usikkerhet eller motargument når faktapakken gir grunnlag.
- En stor 80+ sak med rik faktapakke bør normalt bli en ordentlig finansartikkel på omtrent 500–900 ord totalt, ikke fem korte avsnitt. En tynnere sak skal være kortere; aldri fyll med tomprat.
- Varier rytme og avsnitt. Ingen mekanisk mal, ingen punktliste i leserteksten.
OVERSKRIFT:
- Tittel skal være konkret, interessant og skape en reell grunn til å klikke uten å love mer enn saken leverer.
- Prioriter konsekvens, konflikt, overraskelse, et viktig tall eller et tydelig utsagn fremfor generiske formuleringer som «X kommer med ny melding».
- Bruk nysgjerrighet når den er fortjent, men aldri skjul sakens kjerne bare for å lokke.
- Unngå sensasjonelle standardfraser, kunstige spørsmålstegn og påstander som faktapakken ikke støtter.
- Tittelen skal normalt være stram nok til å fungere som hovedsak på forsiden.
- Se på current_front_page i redaksjonskonteksten og unngå at flere samtidige titler får samme rytme eller formulering.
- Undertittel skal tilføre ny informasjon, ikke gjenta tittelen.

KILDEDISIPLIN:
- Fakta i fact_pack er godkjent kildegrunnlag.
- En sterk etablert nyhetskilde kan alene være nok.
- Ikke skriv interne verifikasjonskommentarer.
- Ikke overkrediter discovery-medier.
- provenance=original_statement/original_document: krediter opprinnelig aktør/dokument når naturlig.
- provenance=exclusive_media_report: krediter mediet tydelig.
- provenance=secondary_report: krediter bare når nødvendig for akkurat opplysningen.
- Direkte sitater skal spores til speaker/origin_context, ikke automatisk til mediet som videreformidlet dem.
- Når et medium faktisk må krediteres og source_url finnes, bruk [Kildenavn](source_url).
- Bruk URL nøyaktig; aldri konstruer en.
- Ikke finn opp markedsreaksjoner, sitater, konsensus, bakgrunnstall eller analytikersyn.

RESULTATER:
- Ved earnings/resultater: identifiser 2–4 tall/signaler som faktisk driver historien.
- Skill omsetning, lønnsomhet, guiding, segmenter og cash flow.
- Bruk beat/miss kun når eksplisitt forventning finnes.
- Forklar hva tallkombinasjonen sier om virksomheten, ikke bare hva hvert tall er.

MARKED:
- Beskriv dokumentert markedsreaksjon når den finnes.
- Egne scenarier/inferenser kan brukes i ai_analysis med tydelig resonnement.
- Ikke skriv generiske avslutninger som «saken kan påvirke markedet».

KVALITETSKONTROLL:
Før du svarer, vurder teksten din som en streng redaktør. quality_score skal måle journalistisk verdi, dybde, flyt og bruk av faktagrunnlaget. Under 65 betyr at utkastet ikke er godt nok og bør skrives om.

BILDE:
- visual_type: press_photo, official_photo, data_chart eller none.
- data_chart når tallutviklingen er kjernen.
- Ikke foreslå syntetisk dokumentarfoto.

Returner kun JSON:
{
  "title":"...",
  "dek":"...",
  "section":"Renter",
  "paragraphs":["...","..."],
  "ai_analysis":"En tydelig, selvstendig analyse på ca. 80–180 ord basert på faktapakken.",
  "quality_score":82,
  "quality_reason":"kort intern vurdering",
  "visual_type":"data_chart",
  "visual_brief":"..."
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
      current_front_page: item.frontPage || [],
      assignment: Number(item.ai_score || 0) >= 80
        ? 'Stor prioritert sak. Gå dypere enn en nyhetsnotis.'
        : 'Vanlig prioritert finanssak. Skriv så dypt som faktagrunnlaget fortjener.',
    },
    ...(previousDraft ? {
      rewrite_instruction: {
        reason: 'Førsteutkastet var for tynt eller fikk for lav kvalitetsscore. Skriv hele saken på nytt, med mer substans og bedre økonomisk analyse, uten å introdusere nye fakta.',
        previous_draft: previousDraft,
      },
    } : {}),
  };

  const result = await deepSeekJson(system, input, previousDraft ? 7600 : 6800);
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

  const frontPage = await sql`
    SELECT tittel, seksjon, ai_score, pinned, publisert_at
    FROM articles
    WHERE status = 'live'
    ORDER BY pinned DESC, pinned_pos ASC NULLS LAST,
             ai_score DESC NULLS LAST, publisert_at DESC NULLS LAST
    LIMIT 8
  `;

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
    frontPage: frontPage.map((article) => ({
      title: article.tittel,
      section: article.seksjon,
      score: article.ai_score == null ? null : Number(article.ai_score),
      isHighlight: article.pinned === true,
      publishedAt: article.publisert_at || null,
    })),
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

  let generated = await writeArticle(item, pack);
  await logUsage(sql, 'article-write-pro', generated.usage);

  let draft = generated.draft;
  let depth = articleDepthCheck(draft, item, pack);

  if (!depth.pass) {
    const rewrite = await writeArticle(item, pack, {
      title: draft.title,
      dek: draft.dek,
      paragraphs: draft.paragraphs,
      ai_analysis: draft.aiAnalysis,
      quality_score: draft.qualityScore,
      quality_reason: draft.qualityReason,
      depth_check: depth,
    });
    await logUsage(sql, 'article-rewrite-pro', rewrite.usage);
    draft = rewrite.draft;
    depth = articleDepthCheck(draft, item, pack);
  }

  if (!draft.title && !draft.dek && !draft.paragraphs.length) {
    throw new Error('AI svarte uten et brukbart artikkelutkast.');
  }

  if (!depth.pass) {
    throw new Error(
      `V4 Pro-utkastet nådde ikke kvalitetskravet etter omskriving (kvalitet ${draft.qualityScore}/100, ${depth.articleWords}/${depth.targetWords} ord, AI-vurdering ${depth.analysisWords} ord).`
    );
  }

  const articleParagraphs = draft.paragraphs.length
    ? draft.paragraphs
    : [draft.dek || pack.headline_fact || 'Utkastet trenger redaksjonell bearbeiding.'];
  const body = [
    ...articleParagraphs,
    ...(draft.aiAnalysis ? [`AI-vurdering: ${draft.aiAnalysis}`] : []),
  ].join('\n\n');

  const numeric = deterministicNumberCheck(draft, pack);
  const verificationStatus = numeric.pass ? 'pending_review' : 'warning';
  const tallValidert = numeric.pass;
  const validationNote = numeric.pass
    ? 'Automatisk tallkontroll mot faktapakken bestått.'
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
          ai_begrunnelse = ${`Utkast fra faktapakke ${row.fact_version} (${row.confidence}/100) · V4 Pro kvalitet ${draft.qualityScore}/100.`},
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
        ${Number(row.ai_score || 0)}, ${`Utkast fra faktapakke ${row.fact_version} (${row.confidence}/100) · V4 Pro kvalitet ${draft.qualityScore}/100.`},
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
      ${verificationStatus}, 0, ${JSON.stringify({ numeric, depth, qualityScore: draft.qualityScore, qualityReason: draft.qualityReason })}::jsonb,
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
