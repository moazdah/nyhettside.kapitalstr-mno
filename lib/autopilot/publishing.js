import { publishCaseArticle } from '../editorial/publish.mjs';
import { db } from '../db';
import { ensureArticleWriterSchema } from '../ai/write-article';
import { linkLiveUpdateToArticle } from '../live-updates';

async function ensurePublishingSchema(sql = db()) {
  await ensureArticleWriterSchema(sql);
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
  const result = await publishCaseArticle(sql, articleId, {
    runId, autoPublishEnabled: process.env.EDITORIAL_AUTOPUBLISH_V1 === 'true',
  });
  if (!result.published || result.reason === 'already_live') return result;
  // Publishing is already committed. A secondary display update cannot turn
  // that success into a retry of the article-writing step.
  const warnings = [];
  try { await linkLiveUpdateToArticle(sql, result.radarId, result.articleId); }
  catch (error) { warnings.push(String(error.message).slice(0, 300)); }
  let highlight = null;
  try { highlight = await refreshAutoHighlight(sql, runId); }
  catch (error) { warnings.push(String(error.message).slice(0, 300)); }
  return { ...result, highlight, warnings };
}
