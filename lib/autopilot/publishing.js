import { db } from '../db';
import { ensureArticleWriterSchema } from '../ai/write-article';
import { linkLiveUpdateToArticle } from '../live-updates';

async function ensurePublishingSchema(sql = db()) {
  await ensureArticleWriterSchema(sql);
  await sql`ALTER TABLE articles ADD COLUMN IF NOT EXISTS pinned_source TEXT`;
}

async function refreshAutoHighlight(sql, runId) {
  const [manualPinned] = await sql`
    SELECT id
    FROM articles
    WHERE status = 'live'
      AND pinned = TRUE
      AND COALESCE(pinned_source, 'manual') <> 'auto'
    LIMIT 1
  `;

  if (manualPinned) {
    return { changed: false, reason: 'manual_highlight_locked', articleId: Number(manualPinned.id) };
  }

  const [best] = await sql`
    SELECT a.id
    FROM articles a
    JOIN radar_items r ON r.id = a.radar_item_id
    WHERE a.status = 'live'
      AND r.autopilot_run_id = ${Number(runId)}
    ORDER BY r.selection_rank ASC NULLS LAST,
             r.selection_score DESC NULLS LAST,
             a.ai_score DESC NULLS LAST,
             a.publisert_at DESC NULLS LAST
    LIMIT 1
  `;

  if (!best) return { changed: false, reason: 'no_live_story_in_run', articleId: null };

  await sql`
    UPDATE articles
    SET pinned = FALSE, pinned_pos = NULL, pinned_source = NULL
    WHERE status = 'live' AND pinned_source = 'auto' AND id <> ${Number(best.id)}
  `;

  await sql`
    UPDATE articles
    SET pinned = TRUE, pinned_pos = 1, pinned_source = 'auto'
    WHERE id = ${Number(best.id)} AND status = 'live'
  `;

  return { changed: true, reason: 'auto_highlight', articleId: Number(best.id) };
}

export async function publishAutopilotArticle(articleId, { runId } = {}) {
  const sql = db();
  await ensurePublishingSchema(sql);

  const [article] = await sql`
    SELECT a.id, a.slug, a.status, a.tall_validert, a.ai_score, a.radar_item_id,
           r.autopilot_run_id, r.selection_rank, r.selection_score
    FROM articles a
    LEFT JOIN radar_items r ON r.id = a.radar_item_id
    WHERE a.id = ${Number(articleId)}
    LIMIT 1
  `;

  if (!article) {
    return { published: false, reason: 'article_not_found', articleId: Number(articleId) };
  }

  if (article.status === 'live') {
    return { published: true, reason: 'already_live', articleId: Number(article.id), slug: article.slug };
  }

  if (article.status !== 'draft') {
    return { published: false, reason: 'not_a_draft', articleId: Number(article.id), slug: article.slug };
  }

  if (article.tall_validert !== true) {
    return {
      published: false,
      reason: 'numeric_validation_required',
      articleId: Number(article.id),
      slug: article.slug,
    };
  }

  if (!runId || Number(article.autopilot_run_id || 0) !== Number(runId)) {
    return {
      published: false,
      reason: 'run_mismatch',
      articleId: Number(article.id),
      slug: article.slug,
    };
  }

  await sql`
    UPDATE articles
    SET status = 'live',
        publisert_at = COALESCE(publisert_at, NOW())
    WHERE id = ${Number(article.id)} AND status = 'draft'
  `;

  await linkLiveUpdateToArticle(sql, article.radar_item_id, article.id);
  const highlight = await refreshAutoHighlight(sql, runId);

  return {
    published: true,
    reason: 'auto_published',
    articleId: Number(article.id),
    slug: article.slug,
    highlight,
  };
}
