import { requireEditorialSchema, getCase } from '../editorial/store.mjs';
import { readCaseQueue } from '../editorial/queue.mjs';
import { db } from '../db';
import { runNewsRadar } from '../radar/news-radar';
import { prepareRadarCandidates, RADAR_MODEL_TAG } from '../radar/local-triage';
import { scorePendingRadarItems } from '../ai/score-radar-items';
import { buildFactPackForRadarItem } from '../research/fact-pack';
import { ensureArticleWriterSchema, generateArticleDraftFromRadar, verifyEditedDraft } from '../ai/write-article';
import { AUTO_SELECTION_LIMIT, createEditorialRun, ensureEditorialSelectionSchema, finishEditorialRun, getEditorialRun, markDiscoveryDone, markTriageDone, selectTopEventsForRun } from './editorial-selection';
import { getEditorialSettings } from './editorial-settings';
import { publishAutopilotArticle } from './publishing';

const SCORE_BATCH = 15;
const RESEARCH_BATCH = 1;
const DRAFT_BATCH = 1;

export async function getAutopilotState(sql = db(), runId = null) {
  await ensureArticleWriterSchema(sql);
  await ensureEditorialSelectionSchema(sql);
  await requireEditorialSchema(sql);
  const run = runId ? await getEditorialRun(sql, runId) : null;
  const cutoff = run?.notes?.scoring_cutoff || null;
  const triagePending = Boolean(runId && run?.discovery_done && !run?.triage_done);
  const [scored] = run?.selection_done ? [{ ready: 0, deferred: 0 }] : await sql`
    SELECT COUNT(*) FILTER (WHERE score_retry_after IS NULL OR score_retry_after <= now())::int AS ready,
      COUNT(*) FILTER (WHERE score_retry_after > now())::int AS deferred
    FROM radar_items WHERE local_triage_status = 'candidate'
      AND (ai_score IS NULL OR ai_model IS DISTINCT FROM ${RADAR_MODEL_TAG})
      AND (${cutoff}::timestamptz IS NULL OR discovered_at <= ${cutoff}::timestamptz)
  `;
  const articleLimit = Number(run?.selection_limit || AUTO_SELECTION_LIMIT);
  const queue = runId ? await readCaseQueue(sql, runId, articleLimit)
    : { researchIds: [], draftIds: [], verifyIds: [], deferredVerification: 0, deferredResearch: 0, deferredDrafting: 0, busy: 0, blocked: 0, failed: 0, draftsCreated: 0, selected: 0 };
  const scoring = Number(scored.ready || 0);
  const deferredScoring = Number(scored.deferred || 0);
  // This run owns a fixed scoring window. Later live-pulse discoveries cannot
  // extend a round which has already selected its events.
  const selectionPending = Boolean(run?.triage_done && !run.selection_done && scoring === 0);
  const research = queue.researchIds.length;
  const drafting = queue.draftIds.length;
  const verification = queue.verifyIds.length;
  const waiting = queue.busy + queue.deferredResearch + queue.deferredDrafting + queue.deferredVerification;
  const done = Boolean(run?.selection_done && !scoring && !research && !drafting && !verification && !waiting);
  const progressPct = done ? 100 : !run?.discovery_done ? 2 : triagePending ? 8 : scoring ? 30 : selectionPending ? 70
    : drafting ? 90 : research ? 78 : 95;
  return { runId: runId ? Number(runId) : null, triagePending, scoring, deferredScoring, selectionPending,
    selected: queue.selected, articleLimit, draftsCreated: queue.draftsCreated, research, drafting, verification, deferredVerification: queue.deferredVerification,
    deferredResearch: queue.deferredResearch, deferredDrafting: queue.deferredDrafting,
    busy: queue.busy, blocked: queue.blocked, failed: queue.failed, waiting,
    progressPct, retryAfterSeconds: waiting ? 15 : 2,
    totalRemaining: scoring + research + drafting + verification + waiting + Number(triagePending) + Number(selectionPending), done };
}

async function nextResearchIds(sql, runId) {
  const run = await getEditorialRun(sql, runId);
  return (await readCaseQueue(sql, runId, Number(run.selection_limit))).researchIds.slice(0, RESEARCH_BATCH);
}

async function nextDraftIds(sql, runId) {
  const run = await getEditorialRun(sql, runId);
  return (await readCaseQueue(sql, runId, Number(run.selection_limit))).draftIds.slice(0, DRAFT_BATCH);
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

export async function runAutopilotStep({ discovery = false, runId = null, mode = 'manual', scheduledSlot = null } = {}) {
  const sql = db();
  await ensureArticleWriterSchema(sql);
  await ensureEditorialSelectionSchema(sql);

  await requireEditorialSchema(sql);

  let activeRunId = runId ? Number(runId) : null;
  if (!activeRunId) {
    const run = await createEditorialRun(
      sql,
      mode === 'scheduled' ? 'scheduled' : 'manual',
      mode === 'scheduled' ? scheduledSlot : null
    );
    activeRunId = Number(run.id);
  }

  const runMeta = await getEditorialRun(sql, activeRunId);
  if (runMeta?.status === 'done') {
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

  if (discovery && !runMeta?.discovery_done) {
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

  if (discovery && runMeta?.discovery_done) {
    const state = await getAutopilotState(sql, activeRunId);
    return {
      ok: true,
      runId: activeRunId,
      stage: 'discovery',
      processed: 0,
      requested: 0,
      discovery: { resumedExistingRun: true },
      errors: [],
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
    const result = await scorePendingRadarItems(SCORE_BATCH, { discoveredBefore: runMeta?.notes?.scoring_cutoff || null });
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
    // The five-minute live pulse owns the live feed. Full article selection
    // must not publish another, less-verified version of the same event.
    const state = await getAutopilotState(sql, activeRunId);
    return {
      ok: true,
      runId: activeRunId,
      stage: 'selection',
      processed: result.selected.length,
      requested: result.clusters,
      selected: result.selected,
      researchPoolLimit: result.researchPoolLimit || result.selected.length,
      articleLimit: result.articleLimit || AUTO_SELECTION_LIMIT,
      errors: [],
      state,
    };
  }

  if (before.verification > 0) {
    const queue = await readCaseQueue(sql, activeRunId, Number(runMeta.selection_limit));
    const radarId = queue.verifyIds[0];
    const editorialCase = await getCase(sql, radarId);
    const errors = [];
    let publication = null;
    try {
      const checked = await verifyEditedDraft(editorialCase.article_id);
      const settings = mode === 'scheduled' ? await getEditorialSettings(sql) : null;
      if (checked.passed && settings?.autoPublishEnabled) publication = await publishAutopilotArticle(editorialCase.article_id, { runId: activeRunId });
    } catch (error) { errors.push(String(error.message).slice(0, 500)); }
    return { ok: true, runId: activeRunId, stage: 'verification', processed: errors.length ? 0 : 1,
      requested: 1, publication, errors, state: await getAutopilotState(sql, activeRunId) };
  }

  if (before.drafting > 0) {
    const ids = await nextDraftIds(sql, activeRunId);
    let processed = 0;
    const errors = [];
    const details = [];

    const publicationSettings = mode === 'scheduled'
      ? await getEditorialSettings(sql)
      : null;

    for (const id of ids) {
      try {
        const result = await generateArticleDraftFromRadar(id);
        let publication = null;

        if (result?.articleId && publicationSettings?.autoPublishEnabled === true) {
          publication = await publishAutopilotArticle(result.articleId, { runId: activeRunId });
        }

        await sql`
          UPDATE radar_items
          SET draft_attempts = 0, draft_retry_after = NULL, draft_last_error = NULL
          WHERE id = ${id}
        `;
        processed += result?.articleId ? 1 : 0;
        details.push({
          id,
          articleId: result?.articleId || null,
          status: publication?.published ? 'live' : (result?.status || 'unknown'),
          tallValidert: result?.tallValidert ?? null,
          publication,
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

  // Only cases owned by this run affect completion; other rounds never extend it.
  if (before.done) {
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

  if (before.waiting) {
    return { ok: true, runId: activeRunId, stage: 'waiting', processed: 0, requested: 0,
      errors: [], state: before };
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
