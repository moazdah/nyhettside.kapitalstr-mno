import { publishCaseArticle } from '../editorial/publish.mjs';
import { db } from '../db';
import { getEditorialSettings } from './editorial-settings';
import { ensureArticleWriterSchema } from '../ai/write-article';
import { linkLiveUpdateToArticle } from '../live-updates';
import { getCase } from '../editorial/store.mjs';
import { assessStory } from '../desk/priority.mjs';
import { attachSource } from '../desk/stories.mjs';
import { selectImageForArticle } from '../media/images';

// Desk placement, the story's source list and image follow a committed publication.
export async function applyDeskDecision(sql, articleId, radarId) {
  const [row] = await sql`SELECT a.tittel, a.undertittel, r.candidate_type, r.ai_score, r.attention_score, r.event_cluster_size,
      COALESCE(r.event_key, r.local_event_key) AS event_key
    FROM articles a JOIN radar_items r ON r.id = a.radar_item_id WHERE a.id = ${Number(articleId)}`;
  if (!row) return null;
  const editorialCase = await getCase(sql, radarId);
  const dossier = editorialCase?.dossier || {};
  const publishedAt = dossier.sources?.[0]?.publication?.at || null;
  const desk = assessStory({ title: row.tittel, summary: row.undertittel, candidateType: row.candidate_type, aiScore: row.ai_score,
    attentionScore: row.attention_score, publishedAt, sourceCount: Number(row.event_cluster_size || 1),
    entities: dossier.factPack?.entities || [] });
  const siblings = row.event_key ? await sql`SELECT url, source_name, title, published_at FROM radar_items
    WHERE COALESCE(event_key, local_event_key) = ${row.event_key} AND url IS NOT NULL ORDER BY published_at NULLS LAST LIMIT 12` : [];
  const documents = (dossier.sources || []).filter(source => source?.fetched && source.url)
    .map((source, i) => ({ source: { url: source.url, name: source.name, title: null, publishedAt: source.publication?.at || null }, role: i === 0 ? 'primary' : 'supporting' }));
  await sql.transaction([
    sql`UPDATE articles SET priority_score = ${desk.score}, placement = ${desk.placement}, desk_assessment = ${JSON.stringify(desk)}::jsonb,
      source_published_at = COALESCE(source_published_at, ${publishedAt}::timestamptz),
      story_key = COALESCE(story_key, ${editorialCase?.event_key || null}) WHERE id = ${Number(articleId)}`,
    ...documents.map(d => attachSource(sql, articleId, d.source, d.role)),
    ...siblings.map(source => attachSource(sql, articleId, source, 'supporting')),
  ]);
  return desk;
}


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
  const settings = await getEditorialSettings(sql);
  const result = await publishCaseArticle(sql, articleId, {
    runId, autoPublishEnabled: settings.automationEnabled && settings.autoPublishEnabled,
  });
  if (!result.published || result.reason === 'already_live') return result;
  // Publishing is already committed. A secondary display update cannot turn
  // that success into a retry of the article-writing step.
  const warnings = [];
  try { await linkLiveUpdateToArticle(sql, result.radarId, result.articleId); }
  catch (error) { warnings.push(String(error.message).slice(0, 300)); }
  let desk = null;
  try { desk = await applyDeskDecision(sql, result.articleId, result.radarId); }
  catch (error) { warnings.push(String(error.message).slice(0, 300)); }
  try { await selectImageForArticle(sql, result.articleId); }
  catch (error) { warnings.push(String(error.message).slice(0, 300)); }
  let highlight = null;
  try { highlight = await refreshAutoHighlight(sql, runId); }
  catch (error) { warnings.push(String(error.message).slice(0, 300)); }
  return { ...result, desk, highlight, warnings };
}
