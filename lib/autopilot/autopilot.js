import { db } from '../db';
import { runNewsRadar } from '../radar/news-radar';
import { prepareRadarCandidates, RADAR_MODEL_TAG } from '../radar/local-triage';
import { scorePendingRadarItems } from '../ai/score-radar-items';
import { buildFactPackForRadarItem } from '../research/fact-pack';
import { ensureArticleWriterSchema, generateArticleDraftFromRadar } from '../ai/write-article';
import { createEditorialRun, ensureEditorialSelectionSchema, finishEditorialRun, getEditorialRun, markDiscoveryDone, markTriageDone, selectTopEventsForRun } from './editorial-selection';

const FACT_PACK_VERSION = 'fact-pack-v7';
const SCORE_BATCH = 10;
const RESEARCH_BATCH = 3;
const DRAFT_BATCH = 2;

export async function getAutopilotState(sql = db(), runId = null) {
  await ensureArticleWriterSchema(sql);
  await ensureEditorialSelectionSchema(sql);

  const run = runId ? await getEditorialRun(sql, runId) : null;
  const triagePending = Boolean(runId && run?.discovery_done && !run?.triage_done);

  const [readyRows, deferredRows] = await Promise.all([
    sql`
      SELECT COUNT(*)::int AS count
      FROM radar_items
      WHERE local_triage_status = 'candidate'
        AND (ai_score IS NULL OR ai_model IS DISTINCT FROM ${RADAR_MODEL_TAG})
        AND (score_retry_after IS NULL OR score_retry_after <= now())
    `,
    sql`
      SELECT COUNT(*)::int AS count
      FROM radar_items
      WHERE local_triage_status = 'candidate'
        AND (ai_score IS NULL OR ai_model IS DISTINCT FROM ${RADAR_MODEL_TAG})
        AND score_retry_after > now()
    `,
  ]);

  let research = 0;
  let deferredResearch = 0;
  let drafting = 0;
  let deferredDrafting = 0;
  let selected = 0;

  if (runId) {
    const [researchRows, deferredResearchRows, draftRows, deferredDraftRows, selectedRows] = await Promise.all([
      sql`
        SELECT COUNT(*)::int AS count
        FROM radar_items r
        LEFT JOIN fact_packs fp ON fp.radar_item_id = r.id
        WHERE r.autopilot_run_id = ${Number(runId)}
          AND (fp.id IS NULL OR fp.version IS DISTINCT FROM ${FACT_PACK_VERSION})
          AND (r.research_retry_after IS NULL OR r.research_retry_after <= now())
      `,
      sql`
        SELECT COUNT(*)::int AS count
        FROM radar_items r
        LEFT JOIN fact_packs fp ON fp.radar_item_id = r.id
        WHERE r.autopilot_run_id = ${Number(runId)}
          AND (fp.id IS NULL OR fp.version IS DISTINCT FROM ${FACT_PACK_VERSION})
          AND r.research_retry_after > now()
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
          AND (r.draft_retry_after IS NULL OR r.draft_retry_after <= now())
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
          AND r.draft_retry_after > now()
      `,
      sql`
        SELECT COUNT(*)::int AS count
        FROM radar_items
        WHERE autopilot_run_id = ${Number(runId)}
      `,
    ]);

    research = Number(researchRows[0]?.count || 0);
    deferredResearch = Number(deferredResearchRows[0]?.count || 0);
    drafting = Number(draftRows[0]?.count || 0);
    deferredDrafting = Number(deferredDraftRows[0]?.count || 0);
    selected = Number(selectedRows[0]?.count || 0);
  }

  const scoring = Number(readyRows[0]?.count || 0);
  const deferredScoring = Number(deferredRows[0]?.count || 0);
  const selectionPending = Boolean(
    runId && run?.triage_done && !run?.selection_done && scoring === 0
  );
  const done = Boolean(
    runId && run?.selection_done && scoring === 0 && research === 0 && drafting === 0
  );

  let progressPct = 0;
  if (runId && run) {
    const scoringTotal = Math.max(Number(run.scoring_total || 0), scoring + deferredScoring, 1);
    const handled = Math.max(0, scoringTotal - scoring);

    if (!run.discovery_done) {
      progressPct = 2;
    } else if (triagePending) {
      progressPct = 8;
    } else if (scoring > 0) {
      progressPct = Math.min(68, Math.round(12 + (handled / scoringTotal) * 56));
    } else if (selectionPending) {
      progressPct = 72;
    } else if (run.selection_done && selected > 0 && research > 0) {
      progressPct = Math.min(88, Math.round(75 + ((selected - research) / selected) * 13));
    } else if (run.selection_done && selected > 0 && drafting > 0) {
      progressPct = Math.min(99, Math.round(88 + ((selected - drafting) / selected) * 11));
    } else if (done || (run.selection_done && selected === 0)) {
      progressPct = 100;
    } else if (run.selection_done) {
      progressPct = 94;
    }
  }

  return {
    runId: runId ? Number(runId) : null,
    triagePending,
    scoring,
    deferredScoring,
    selectionPending,
    selected,
    research,
    deferredResearch,
    drafting,
    deferredDrafting,
    progressPct,
    totalRemaining: (triagePending ? 1 : 0) + scoring + research + drafting + (selectionPending ? 1 : 0),
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
      AND (r.research_retry_after IS NULL OR r.research_retry_after <= now())
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
      AND (r.draft_retry_after IS NULL OR r.draft_retry_after <= now())
    ORDER BY r.ai_score DESC, r.attention_score DESC NULLS LAST, fp.confidence DESC NULLS LAST
    LIMIT ${DRAFT_BATCH}
  `;
  return rows.map((row) => Number(row.id));
}

async function nextRecoveryResearchIds(sql, activeRunId) {
  const rows = await sql`
    SELECT r.id
    FROM radar_items r
    LEFT JOIN fact_packs fp ON fp.radar_item_id = r.id
    WHERE r.autopilot_run_id IS NOT NULL
      AND r.autopilot_run_id <> ${Number(activeRunId)}
      AND r.research_retry_after IS NOT NULL
      AND r.research_retry_after <= now()
      AND (fp.id IS NULL OR fp.version IS DISTINCT FROM ${FACT_PACK_VERSION})
    ORDER BY r.research_retry_after ASC
    LIMIT 1
  `;
  return rows.map((row) => Number(row.id));
}

async function nextRecoveryDraftIds(sql, activeRunId) {
  const rows = await sql`
    SELECT r.id
    FROM radar_items r
    JOIN fact_packs fp ON fp.radar_item_id = r.id
    WHERE r.autopilot_run_id IS NOT NULL
      AND r.autopilot_run_id <> ${Number(activeRunId)}
      AND r.draft_retry_after IS NOT NULL
      AND r.draft_retry_after <= now()
      AND fp.version = ${FACT_PACK_VERSION}
      AND fp.status = 'ready'
      AND fp.can_write = true
      AND NOT EXISTS (
        SELECT 1 FROM articles a WHERE a.radar_item_id = r.id
      )
    ORDER BY r.draft_retry_after ASC
    LIMIT 1
  `;
  return rows.map((row) => Number(row.id));
}

async function deferResearch(sql, id, message) {
  await sql`
    UPDATE radar_items
    SET research_attempts = COALESCE(research_attempts, 0) + 1,
        research_last_error = ${message},
        research_retry_after = now() + CASE
          WHEN COALESCE(research_attempts, 0) >= 2 THEN interval '20 minutes'
          WHEN COALESCE(research_attempts, 0) = 1 THEN interval '7 minutes'
          ELSE interval '2 minutes'
        END
    WHERE id = ${id}
  `;
}

async function deferDraft(sql, id, message) {
  await sql`
    UPDATE radar_items
    SET draft_attempts = COALESCE(draft_attempts, 0) + 1,
        draft_last_error = ${message},
        draft_retry_after = now() + CASE
          WHEN COALESCE(draft_attempts, 0) >= 2 THEN interval '20 minutes'
          WHEN COALESCE(draft_attempts, 0) = 1 THEN interval '7 minutes'
          ELSE interval '2 minutes'
        END
    WHERE id = ${id}
  `;
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
      discovery: {
        seen: Number(discoveryResult.seen || 0),
        inserted: Number(discoveryResult.inserted || 0),
        globalSeen: Number(discoveryResult.globalSeen || 0),
        globalInserted: Number(discoveryResult.globalInserted || 0),
        pruned: Number(discoveryResult.pruned || 0),
      },
      errors: Array.isArray(discoveryResult.errors) ? discoveryResult.errors.map(String) : [],
      state,
    };
  }

  const before = await getAutopilotState(sql, activeRunId);

  if (before.triagePending) {
    const result = await prepareRadarCandidates(sql);
    await markTriageDone(sql, activeRunId, result);
    const state = await getAutopilotState(sql, activeRunId);
    return {
      ok: true,
      runId: activeRunId,
      stage: 'triage',
      processed: Number(result.candidates || 0),
      requested: Number(result.scanned || 0),
      triage: result,
      errors: [],
      state,
    };
  }

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
        await sql`
          UPDATE radar_items
          SET research_attempts = 0, research_retry_after = NULL, research_last_error = NULL
          WHERE id = ${id}
        `;
        processed += 1;
        details.push({ id, status: result.status, confidence: result.confidence ?? null });
      } catch (error) {
        const message = String(error?.message || 'Ukjent feil').slice(0, 500);
        errors.push(`Radar ${id}: ${message}`);
        await deferResearch(sql, id, message);
        details.push({ id, deferred: true, error: message });
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
        await sql`
          UPDATE radar_items
          SET draft_attempts = 0, draft_retry_after = NULL, draft_last_error = NULL
          WHERE id = ${id}
        `;
        processed += result?.articleId ? 1 : 0;
        details.push({
          id,
          articleId: result?.articleId || null,
          status: result?.status || 'unknown',
          tallValidert: result?.tallValidert ?? null,
        });
      } catch (error) {
        const message = String(error?.message || 'Ukjent feil').slice(0, 500);
        errors.push(`Radar ${id}: ${message}`);
        await deferDraft(sql, id, message);
        details.push({ id, deferred: true, error: message });
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

  const recoveryResearchIds = await nextRecoveryResearchIds(sql, activeRunId);
  if (recoveryResearchIds.length) {
    const id = recoveryResearchIds[0];
    try {
      const result = await buildFactPackForRadarItem(id);
      await sql`
        UPDATE radar_items
        SET research_attempts = 0, research_retry_after = NULL, research_last_error = NULL
        WHERE id = ${id}
      `;
      return {
        ok: true,
        runId: activeRunId,
        stage: 'recovery',
        processed: 1,
        requested: 1,
        errors: [],
        details: [{ id, kind: 'research', status: result.status }],
        state: { ...(await getAutopilotState(sql, activeRunId)), done: false, progressPct: 98 },
      };
    } catch (error) {
      const message = String(error?.message || 'Ukjent feil').slice(0, 500);
      await deferResearch(sql, id, message);
      return {
        ok: true,
        runId: activeRunId,
        stage: 'recovery',
        processed: 0,
        requested: 1,
        errors: [`Retry research ${id}: ${message}`],
        details: [{ id, kind: 'research', deferred: true }],
        state: { ...(await getAutopilotState(sql, activeRunId)), done: false, progressPct: 98 },
      };
    }
  }

  const recoveryDraftIds = await nextRecoveryDraftIds(sql, activeRunId);
  if (recoveryDraftIds.length) {
    const id = recoveryDraftIds[0];
    try {
      const result = await generateArticleDraftFromRadar(id);
      await sql`
        UPDATE radar_items
        SET draft_attempts = 0, draft_retry_after = NULL, draft_last_error = NULL
        WHERE id = ${id}
      `;
      return {
        ok: true,
        runId: activeRunId,
        stage: 'recovery',
        processed: result?.articleId ? 1 : 0,
        requested: 1,
        errors: [],
        details: [{ id, kind: 'draft', articleId: result?.articleId || null }],
        state: { ...(await getAutopilotState(sql, activeRunId)), done: false, progressPct: 98 },
      };
    } catch (error) {
      const message = String(error?.message || 'Ukjent feil').slice(0, 500);
      await deferDraft(sql, id, message);
      return {
        ok: true,
        runId: activeRunId,
        stage: 'recovery',
        processed: 0,
        requested: 1,
        errors: [`Retry utkast ${id}: ${message}`],
        details: [{ id, kind: 'draft', deferred: true }],
        state: { ...(await getAutopilotState(sql, activeRunId)), done: false, progressPct: 98 },
      };
    }
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
