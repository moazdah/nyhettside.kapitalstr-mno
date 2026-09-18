import { db } from './db';
import { ensureRawItemScoringSchema } from './ai/score-raw-items';
import { ensureArticleWriterSchema } from './ai/write-article';
import { ensureEditorialSelectionSchema } from './autopilot/editorial-selection';

export async function getAdminData() {
  const sql = db();
  await Promise.all([ensureRawItemScoringSchema(sql), ensureArticleWriterSchema(sql), ensureEditorialSelectionSchema(sql)]);

  const [queue, published, feed, sources, usage, liveOrder, policyRate, rawItems, radarItems] = await Promise.all([
    sql`
      SELECT a.id, a.slug, a.tittel, a.seksjon, a.ai_score, a.ai_begrunnelse,
             a.tall_validert, a.valideringsnotat, a.created_at, a.kilde_url,
             s.navn AS kilde_navn
      FROM articles a
      LEFT JOIN sources s ON s.id = a.kilde_id
      WHERE a.status = 'draft'
      ORDER BY a.ai_score DESC NULLS LAST, a.created_at DESC
      LIMIT 50
    `,
    sql`
      SELECT id, slug, tittel, seksjon, forfatter, publisert_at, pinned, pinned_pos
      FROM articles
      WHERE status = 'live'
      ORDER BY publisert_at DESC NULLS LAST, created_at DESC
      LIMIT 50
    `,
    sql`
      SELECT id, tekst, seksjon, tidspunkt, status
      FROM feed
      ORDER BY tidspunkt DESC
      LIMIT 50
    `,
    sql`
      SELECT id, navn, type, url, aktiv, intervall_min, sist_hentet
      FROM sources
      ORDER BY navn
    `,
    sql`
      SELECT steg, modell,
             COALESCE(SUM(tokens_inn), 0)::int AS tokens_inn,
             COALESCE(SUM(tokens_ut), 0)::int AS tokens_ut,
             COALESCE(SUM(kostnad_usd), 0)::numeric AS kostnad_usd
      FROM ai_usage
      WHERE created_at >= date_trunc('day', now())
      GROUP BY steg, modell
      ORDER BY steg
    `,
    sql`
      SELECT id, slug, tittel, seksjon, ai_score, pinned, pinned_pos, publisert_at
      FROM articles
      WHERE status = 'live'
      ORDER BY pinned DESC, pinned_pos ASC NULLS LAST,
               ai_score DESC NULLS LAST, publisert_at DESC NULLS LAST
      LIMIT 20
    `,
    sql`
      SELECT symbol, navn, verdi, endring_pct, oppdatert
      FROM markets
      WHERE symbol = 'NOKPOLICY'
      LIMIT 1
    `,
    sql`
      SELECT r.id, r.tittel, r.publisert, r.url, r.behandlet,
             r.ai_score, r.ai_seksjon, r.ai_begrunnelse, r.ai_modell, r.scored_at,
             s.navn AS kilde_navn
      FROM raw_items r
      LEFT JOIN sources s ON s.id = r.kilde_id
      ORDER BY r.publisert DESC NULLS LAST, r.id DESC
      LIMIT 30
    `,
    sql`
      SELECT r.id, r.source_name, r.source_domain, r.source_kind, r.title, r.summary, r.url, r.image_url,
             r.published_at, r.discovered_at, r.ai_score, r.ai_section, r.ai_reason, r.ai_model,
             r.attention_score, r.attention_reason, r.numbers_score,
             r.event_key, r.event_group_title, r.event_cluster_size,
             r.autopilot_run_id, r.autopilot_selected_at, r.selection_rank, r.selection_score,
             r.candidate_type, r.credit_required, r.next_step, r.primary_source_status,
             r.primary_source_name, r.primary_source_url,
             fp.status AS fact_pack_status, fp.version AS fact_pack_version, fp.source_role, fp.source_quality, fp.headline_fact, fp.event_type AS fact_event_type,
             fp.facts, fp.numbers, fp.unknowns, fp.market_relevance, fp.can_write,
             fp.confidence AS fact_confidence, fp.ai_reason AS fact_reason
      FROM radar_items r
      LEFT JOIN fact_packs fp ON fp.radar_item_id = r.id
      ORDER BY
               CASE
                 WHEN r.ai_score IS NULL THEN 0
                 WHEN r.ai_model = 'deepseek-flash/radar-v3' THEN 1
                 ELSE 2
               END,
               CASE WHEN r.ai_score IS NULL THEN r.published_at END DESC NULLS LAST,
               r.ai_score DESC NULLS LAST,
               r.attention_score DESC NULLS LAST,
               r.numbers_score DESC NULLS LAST,
               r.published_at DESC NULLS LAST,
               r.discovered_at DESC
      LIMIT 160
    `,
  ]);
  return { queue, published, feed, sources, usage, liveOrder, policyRate: policyRate[0] || null, rawItems, radarItems };
}

export async function approveDraft(id) {
  const sql = db();
  await sql`
    UPDATE articles
    SET status = 'live', publisert_at = COALESCE(publisert_at, now())
    WHERE id = ${id} AND status = 'draft'
  `;
}

export async function rejectDraft(id) {
  const sql = db();
  await sql`UPDATE articles SET status = 'avvist' WHERE id = ${id} AND status = 'draft'`;
}

export async function archiveArticle(id) {
  const sql = db();
  await sql`UPDATE articles SET status = 'arkivert', pinned = false, pinned_pos = NULL WHERE id = ${id}`;
}

export async function setPinned(id, pinned) {
  const sql = db();
  if (pinned) {
    await sql`UPDATE articles SET pinned = true, pinned_pos = 1 WHERE id = ${id} AND status = 'live'`;
  } else {
    await sql`UPDATE articles SET pinned = false, pinned_pos = NULL WHERE id = ${id} AND status = 'live'`;
  }
}


export async function getDraftDetail(id) {
  const sql = db();
  await ensureArticleWriterSchema(sql);

  const [article] = await sql`
    SELECT a.id, a.slug, a.status, a.tittel, a.undertittel, a.brodtekst, a.seksjon,
           a.forfatter, a.bilde_url, a.bilde_kreditt, a.ai_score, a.ai_begrunnelse, a.ai_modell, a.tall_validert,
           a.valideringsnotat, a.kilde_url, a.created_at, a.radar_item_id, a.fact_pack_id,
           ap.discovery_source_name, ap.discovery_url, ap.primary_source_name,
           ap.primary_source_url, ap.source_role, ap.source_quality, ap.credit_required, ap.generation_model,
           ap.generation_ruleset, ap.verification_status, ap.verification_confidence,
           ap.verification_details, ap.visual_type, ap.visual_brief,
           fp.version AS fact_pack_version, fp.headline_fact, fp.event_type,
           fp.facts, fp.numbers, fp.unknowns, fp.market_relevance, fp.confidence AS fact_confidence
    FROM articles a
    LEFT JOIN article_provenance ap ON ap.article_id = a.id
    LEFT JOIN fact_packs fp ON fp.id = a.fact_pack_id
    WHERE a.id = ${Number(id)} AND a.status = 'draft'
    LIMIT 1
  `;
  return article || null;
}


export async function updateDraftArticle(id, fields) {
  const sql = db();
  const allowedSections = new Set(['Markeder', 'Selskaper', 'Økonomi', 'Renter', 'Analyse', 'Kalender']);
  const section = allowedSections.has(String(fields.seksjon || '').trim())
    ? String(fields.seksjon).trim()
    : 'Markeder';

  const title = String(fields.tittel || '').trim().slice(0, 220);
  const dek = String(fields.undertittel || '').trim().slice(0, 700);
  const body = String(fields.brodtekst || '').trim().slice(0, 30000);
  const author = String(fields.forfatter || 'Kapitalstrøm').trim().slice(0, 120) || 'Kapitalstrøm';
  const imageUrl = String(fields.bilde_url || '').trim().slice(0, 2000) || null;
  const imageCredit = String(fields.bilde_kreditt || '').trim().slice(0, 500) || null;

  if (!title) throw new Error('Tittel kan ikke være tom.');
  if (!body) throw new Error('Brødtekst kan ikke være tom.');

  const [article] = await sql`
    UPDATE articles
    SET tittel = ${title},
        undertittel = ${dek || null},
        brodtekst = ${body},
        seksjon = ${section},
        forfatter = ${author},
        bilde_url = ${imageUrl},
        bilde_kreditt = ${imageCredit},
        tall_validert = false,
        valideringsnotat = 'Utkastet er manuelt redigert. Automatisk kontrollstatus er derfor nullstilt; redaktør må kontrollere endringene før publisering.'
    WHERE id = ${Number(id)} AND status = 'draft'
    RETURNING id
  `;

  if (!article) throw new Error('Fant ikke utkastet.');
  return article;
}


export async function createManualDraft() {
  const sql = db();
  await ensureArticleWriterSchema(sql);

  const slug = `egen-artikkel-${Date.now()}`;
  const [article] = await sql`
    INSERT INTO articles (
      slug, status, tittel, undertittel, brodtekst, seksjon, forfatter,
      ai_modell, tall_validert, valideringsnotat, created_at
    )
    VALUES (
      ${slug}, 'draft', 'Ny artikkel', NULL, 'Skriv artikkelen her.',
      'Markeder', 'Kapitalstrøm', 'manual', false,
      'Manuelt opprettet utkast. Redaktør kontrollerer innhold og kilder før publisering.',
      now()
    )
    RETURNING id
  `;

  return article;
}
