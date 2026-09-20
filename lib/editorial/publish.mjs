import { articleSnapshot, factSnapshot, publicationGate } from './contract.mjs';
import { getCase, claimCase, finishCase, failCase } from './store.mjs';

export async function publishCaseArticle(sql, articleId, { runId = null, manual = false, autoPublishEnabled = false } = {}) {
  const [article] = await sql`SELECT * FROM articles WHERE id = ${Number(articleId)}`;
  if (!article) return { published: false, reason: 'article_not_found' };
  const editorialCase = await getCase(sql, article.radar_item_id);
  if (!editorialCase) return { published: false, reason: 'case_missing_rebuild_research' };
  if (article.status === 'live' && editorialCase.state === 'published') return { published: true, reason: 'already_live', articleId: Number(article.id), slug: article.slug };
  if (article.status !== 'draft') return { published: false, reason: 'not_a_draft' };
  if (!manual && !autoPublishEnabled) return { published: false, reason: 'editorial_review_mode', articleId: Number(article.id) };
  if (!manual && (!runId || Number(runId) !== Number(editorialCase.run_id))) return { published: false, reason: 'run_mismatch' };
  const [pack] = await sql`SELECT * FROM fact_packs WHERE id = ${Number(article.fact_pack_id)}`;
  const snapshot = factSnapshot(pack || {});
  const gate = publicationGate(editorialCase.dossier, article, snapshot);
  if (!gate.passed) return { published: false, reason: 'publication_blocked', reasons: gate.reasons, articleId: Number(article.id) };
  const claim = await claimCase(sql, editorialCase, 'publish');
  try {
    await finishCase(sql, claim, [
      sql`SELECT editorial_assert_publication(${Number(claim.id)}, ${claim.token}::uuid,
        ${JSON.stringify(articleSnapshot(article))}::jsonb, ${JSON.stringify(snapshot)}::jsonb)`,
      sql`UPDATE articles SET status = 'live', publisert_at = COALESCE(publisert_at, now()) WHERE id = ${Number(article.id)}`,
    ], { state: 'published', dossier: claim.dossier, articleId: article.id, details: { mode: manual ? 'manual_review' : 'automatic', gate } });
    return { published: true, reason: manual ? 'reviewed_and_published' : 'auto_published', articleId: Number(article.id), slug: article.slug, radarId: Number(article.radar_item_id) };
  } catch (error) { await failCase(sql, claim, error).catch(() => {}); throw error; }
}
