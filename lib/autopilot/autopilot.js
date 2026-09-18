import { db } from '../db';
import { runNewsRadar } from '../radar/news-radar';
import { scorePendingRadarItems } from '../ai/score-radar-items';
import { buildFactPackForRadarItem } from '../research/fact-pack';
import { ensureArticleWriterSchema, generateArticleDraftFromRadar } from '../ai/write-article';
import { createEditorialRun, ensureEditorialSelectionSchema, finishEditorialRun, getEditorialRun, markDiscoveryDone, selectTopEventsForRun, RADAR_MODEL_TAG } from './editorial-selection';

const FACT_PACK_VERSION = 'fact-pack-v7';
const SCORE_BATCH = 10;
const RESEARCH_BATCH = 3;
const DRAFT_BATCH = 2;

export async function getAutopilotState(sql = db(), runId = null) {
  await ensureArticleWriterSchema(sql);
  await ensureEditorialSelectionSchema(sql);

  const run = runId ? await getEditorialRun(sql, runId) : null;

  const [readyRows, deferredRows] = await Promise.all([
    sql`
      SELECT COUNT(*)::int AS count
      FROM radar_items
      WHERE (ai_score IS NULL OR ai_model IS DISTINCT FROM ${RADAR_MODEL_TAG})
        AND (score_retry_after IS NULL OR score_retry_after <= now())
    `,
    sql`
      SELECT COUNT(*)::int AS count
      FROM radar_items
      WHERE (ai_score IS NULL OR ai_model IS DISTINCT FROM ${RADAR_MODEL_TAG})
        AND score_retry_after > now()
    `,
  ]);

  let research = 0;
  let drafting = 0;
  let selected = 0;

  if (runId) {
    const [researchRows, draftRows, selectedRows] = await Promise.all([
      sql`
        SELECT COUNT(*)::int AS count
        FROM radar_items r
        LEFT JOIN fact_packs fp ON fp.radar_item_id = r.id
        WHERE r.autopilot_run_id = ${Number(runId)}
          AND (fp.id IS NULL OR fp.version IS DISTINCT FROM ${FACT_PACK_VERSION})
      `,
      sql`
        SELECT COUNT(*)::int AS count
        FROM radar_items r
        JOIN fact_packs fp ON fp.radar_item_id = r.id
        WHERE r.autopilot_run_id = ${Number(runId)}
          AND fp.version = ${FACT_PACK_VERSION}
          AND fp.status = 'ready'
          AND fp.can_write = true
          AND NOT EXISTS (
            SELECT 1 FROM articles a WHERE a.radar_item_id = r.id
          )
      `,
      sql`
        SELECT COUNT(*)::int AS count
        FROM radar_items
        WHERE autopilot_run_id = ${Number(runId)}
      `,
    ]);
    research = Number(researchRows[0]?.count || 0);
    drafting = Number(draftRows[0]?.count || 0);
    selected = Number(selectedRows[0]?.count || 0);
  }

  const scoring = Number(readyRows[0]?.count || 0);
  const deferredScoring = Number(deferredRows[0]?.count || 0);
  const selectionPending = Boolean(runId && run && !run.selection_done && scoring === 0);
  const done = Boolean(runId && run?.selection_done && scoring === 0 && research === 0 && drafting === 0);

  let progressPct = 0;
  if (runId && run) {
    const scoringTotal = Math.max(Number(run.scoring_total || 0), scoring + deferredScoring, 1);
    const handled = Math.max(0, scoringTotal - scoring);
    if (scoring > 0) {
      progressPct = Math.min(65, Math.round(5 + (handled / scoringTotal) * 60));
    } else if (selectionPending) {
      progressPct = 68;
    } else if (run.selection_done && selected > 0 && research > 0) {
      progressPct = Math.min(88, Math.round(70 + ((selected - research) / selected) * 18));
    } else if (run.selection_done && selected > 0 && drafting > 0) {
      progressPct = Math.min(99, Math.round(88 + ((selected - drafting) / selected) * 12));
    } else if (done || (run.selection_done && selected === 0)) {
      progressPct = 100;
    } else if (run.selection_done) {
      progressPct = 92;
    }
  }

  return {
    runId: runId ? Number(runId) : null,
    scoring,
    deferredScoring,
    selectionPending,
    selected,
    research,
    drafting,
    progressPct,
    totalRemaining: scoring + research + drafting + (selectionPending ? 1 : 0),
    done,
  };
}

async function nextResearchIds(sql, runId) {
  const rows = await sql`
    SELECT r.id
    FROM radar_items r
    LEFT JOIN fact_packs fp ON fp.radar_item_id = r.id
    WHERE r.autopilot_run_id = ${Number(runId)}
      AND (fp.id IS NULL OR fp.version IS DISTINCT FROM ${FACT_PACK_VERSION})
    ORDER BY r.ai_score DESC, r.attention_score DESC NULLS LAST, r.published_at DESC NULLS LAST
    LIMIT ${RESEARCH_BATCH}
  `;
  return rows.map((row) => Number(row.id));
}

async function nextDraftIds(sql, runId) {
  const rows = await sql`
    SELECT r.id
    FROM radar_items r
    JOIN fact_packs fp ON fp.radar_item_id = r.id
    WHERE r.autopilot_run_id = ${Number(runId)}
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

export async function runAutopilotStep({ discovery = false, runId = null } = {}) {
  const sql = db();
  await ensureArticleWriterSchema(sql);
  await ensureEditorialSelectionSchema(sql);

  let activeRunId = runId ? Number(runId) : null;
  if (!activeRunId) {
    const run = await createEditorialRun(sql, 'manual');
    activeRunId = Number(run.id);
  }

  if (discovery) {
    const discoveryResult = await runNewsRadar();
    await markDiscoveryDone(sql, activeRunId);
    const state = await getAutopilotState(sql, activeRunId);
    return {
      ok: true,
      runId: activeRunId,
      stage: 'discovery',
      processed: Number(discoveryResult.inserted || 0),
      discovery: discoveryResult,
      errors: discoveryResult.errors || [],
      state,
    };
  }

  const before = await getAutopilotState(sql, activeRunId);

  if (before.scoring > 0) {
    const result = await scorePendingRadarItems(SCORE_BATCH);
    const state = await getAutopilotState(sql, activeRunId);
    return {
      ok: true,
      runId: activeRunId,
      stage: 'scoring',
      processed: Number(result.scored || 0),
      requested: Number(result.requested || 0),
      errors: result.errors || [],
      details: result.batches || [],
      state,
    };
  }

  if (before.selectionPending) {
    const result = await selectTopEventsForRun(sql, activeRunId);
    const state = await getAutopilotState(sql, activeRunId);
    return {
      ok: true,
      runId: activeRunId,
      stage: 'selection',
      processed: result.selected.length,
      requested: result.clusters,
      selected: result.selected,
      errors: [],
      state,
    };
  }

  if (before.research > 0) {
    const ids = await nextResearchIds(sql, activeRunId);
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

    const state = await getAutopilotState(sql, activeRunId);
    return {
      ok: true,
      runId: activeRunId,
      stage: 'research',
      processed,
      requested: ids.length,
      errors,
      details,
      state,
    };
  }

  if (before.drafting > 0) {
    const ids = await nextDraftIds(sql, activeRunId);
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

    const state = await getAutopilotState(sql, activeRunId);
    return {
      ok: true,
      runId: activeRunId,
      stage: 'drafting',
      processed,
      requested: ids.length,
      errors,
      details,
      state,
    };
  }

  await finishEditorialRun(sql, activeRunId);
  const state = await getAutopilotState(sql, activeRunId);
  return {
    ok: true,
    runId: activeRunId,
    stage: 'done',
    processed: 0,
    requested: 0,
    errors: [],
    state: { ...state, done: true },
  };
}
