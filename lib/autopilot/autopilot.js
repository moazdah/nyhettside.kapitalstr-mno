import { db } from '../db';
import { runNewsRadar } from '../radar/news-radar';
import { scorePendingRadarItems } from '../ai/score-radar-items';
import { buildFactPackForRadarItem } from '../research/fact-pack';
import { ensureArticleWriterSchema, generateArticleDraftFromRadar } from '../ai/write-article';

const RADAR_MODEL_TAG = 'deepseek-flash/radar-v3';
const FACT_PACK_VERSION = 'fact-pack-v7';
const SCORE_BATCH = 30;
const RESEARCH_BATCH = 3;
const DRAFT_BATCH = 2;

export async function getAutopilotState(sql = db()) {
  await ensureArticleWriterSchema(sql);

  const [scoreRows, researchRows, draftRows, candidateRows] = await Promise.all([
    sql`
      SELECT COUNT(*)::int AS count
      FROM radar_items
      WHERE ai_score IS NULL OR ai_model IS DISTINCT FROM ${RADAR_MODEL_TAG}
    `,
    sql`
      SELECT COUNT(*)::int AS count
      FROM radar_items r
      LEFT JOIN fact_packs fp ON fp.radar_item_id = r.id
      WHERE r.ai_model = ${RADAR_MODEL_TAG}
        AND r.ai_score >= 60
        AND (fp.id IS NULL OR fp.version IS DISTINCT FROM ${FACT_PACK_VERSION})
    `,
    sql`
      SELECT COUNT(*)::int AS count
      FROM radar_items r
      JOIN fact_packs fp ON fp.radar_item_id = r.id
      WHERE r.ai_model = ${RADAR_MODEL_TAG}
        AND r.ai_score >= 60
        AND fp.version = ${FACT_PACK_VERSION}
        AND fp.status = 'ready'
        AND fp.can_write = true
        AND NOT EXISTS (
          SELECT 1 FROM articles a WHERE a.radar_item_id = r.id
        )
    `,
    sql`
      SELECT COUNT(*)::int AS count
      FROM radar_items r
      WHERE r.ai_model = ${RADAR_MODEL_TAG}
        AND r.ai_score >= 60
    `,
  ]);

  const scoring = Number(scoreRows[0]?.count || 0);
  const research = Number(researchRows[0]?.count || 0);
  const drafting = Number(draftRows[0]?.count || 0);
  const candidates = Number(candidateRows[0]?.count || 0);

  return {
    scoring,
    research,
    drafting,
    candidates,
    totalRemaining: scoring + research + drafting,
    done: scoring + research + drafting === 0,
  };
}

async function nextResearchIds(sql) {
  const rows = await sql`
    SELECT r.id
    FROM radar_items r
    LEFT JOIN fact_packs fp ON fp.radar_item_id = r.id
    WHERE r.ai_model = ${RADAR_MODEL_TAG}
      AND r.ai_score >= 60
      AND (fp.id IS NULL OR fp.version IS DISTINCT FROM ${FACT_PACK_VERSION})
    ORDER BY r.ai_score DESC, r.attention_score DESC NULLS LAST, r.published_at DESC NULLS LAST
    LIMIT ${RESEARCH_BATCH}
  `;
  return rows.map((row) => Number(row.id));
}

async function nextDraftIds(sql) {
  const rows = await sql`
    SELECT r.id
    FROM radar_items r
    JOIN fact_packs fp ON fp.radar_item_id = r.id
    WHERE r.ai_model = ${RADAR_MODEL_TAG}
      AND r.ai_score >= 60
      AND fp.version = ${FACT_PACK_VERSION}
      AND fp.status = 'ready'
      AND fp.can_write = true
      AND NOT EXISTS (
        SELECT 1 FROM articles a WHERE a.radar_item_id = r.id
      )
    ORDER BY r.ai_score DESC, r.attention_score DESC NULLS LAST, fp.confidence DESC NULLS LAST
    LIMIT ${DRAFT_BATCH}
  `;
  return rows.map((row) => Number(row.id));
}

export async function runAutopilotStep({ discovery = false } = {}) {
  const sql = db();
  await ensureArticleWriterSchema(sql);

  if (discovery) {
    const discoveryResult = await runNewsRadar();
    const state = await getAutopilotState(sql);
    return {
      ok: true,
      stage: 'discovery',
      processed: Number(discoveryResult.inserted || 0),
      discovery: discoveryResult,
      errors: discoveryResult.errors || [],
      state,
    };
  }

  const before = await getAutopilotState(sql);

  if (before.scoring > 0) {
    const result = await scorePendingRadarItems(SCORE_BATCH);
    const state = await getAutopilotState(sql);
    return {
      ok: true,
      stage: 'scoring',
      processed: Number(result.scored || 0),
      requested: Number(result.requested || 0),
      errors: result.errors || [],
      details: result.batches || [],
      state,
    };
  }

  if (before.research > 0) {
    const ids = await nextResearchIds(sql);
    let processed = 0;
    const errors = [];
    const details = [];

    for (const id of ids) {
      try {
        const result = await buildFactPackForRadarItem(id);
        processed += 1;
        details.push({ id, status: result.status, confidence: result.confidence ?? null });
      } catch (error) {
        const message = error?.message || 'Ukjent feil';
        errors.push(`Radar ${id}: ${message}`);
        details.push({ id, error: message });
      }
    }

    const state = await getAutopilotState(sql);
    return {
      ok: true,
      stage: 'research',
      processed,
      requested: ids.length,
      errors,
      details,
      state,
    };
  }

  if (before.drafting > 0) {
    const ids = await nextDraftIds(sql);
    let processed = 0;
    const errors = [];
    const details = [];

    for (const id of ids) {
      try {
        const result = await generateArticleDraftFromRadar(id);
        processed += result?.articleId ? 1 : 0;
        details.push({
          id,
          articleId: result?.articleId || null,
          status: result?.status || 'unknown',
          tallValidert: result?.tallValidert ?? null,
        });
      } catch (error) {
        const message = error?.message || 'Ukjent feil';
        errors.push(`Radar ${id}: ${message}`);
        details.push({ id, error: message });
      }
    }

    const state = await getAutopilotState(sql);
    return {
      ok: true,
      stage: 'drafting',
      processed,
      requested: ids.length,
      errors,
      details,
      state,
    };
  }

  return {
    ok: true,
    stage: 'done',
    processed: 0,
    requested: 0,
    errors: [],
    state: before,
  };
}
