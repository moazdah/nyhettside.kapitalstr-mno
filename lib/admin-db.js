import { db } from './db';
import { ensureRawItemScoringSchema } from './ai/score-raw-items';
import { ensureRadarSchema } from './radar/news-radar';

export async function getAdminData() {
  const sql = db();
  await Promise.all([ensureRawItemScoringSchema(sql), ensureRadarSchema(sql)]);

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
      SELECT id, source_name, source_domain, source_kind, title, summary, url, image_url,
             published_at, discovered_at, ai_score, ai_section, ai_reason, ai_model,
             candidate_type, credit_required, next_step, primary_source_status,
             primary_source_name, primary_source_url
      FROM radar_items
      ORDER BY ai_score DESC NULLS LAST, published_at DESC NULLS LAST, discovered_at DESC
      LIMIT 80
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
