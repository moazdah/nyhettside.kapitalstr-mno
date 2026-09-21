export function caseQueue(rows, limit = 3, now = Date.now()) {
  const queue = { researchIds: [], draftIds: [], verifyIds: [], deferredResearch: 0, deferredDrafting: 0, deferredVerification: 0, busy: 0, blocked: 0, failed: 0, draftsCreated: 0 };
  for (const row of rows) {
    if (['draft','live','arkivert'].includes(row.article_status)) queue.draftsCreated++;
    if (row.state === 'blocked') { queue.blocked++; continue; }
    if (row.lease_until && new Date(row.lease_until).getTime() > now) { queue.busy++; continue; }
    const step = ['selected','researching'].includes(row.state) ? 'research'
      : ['ready','writing'].includes(row.state) ? 'write'
        : row.state === 'verifying' || (row.state === 'review' && [true,'true'].includes(row.verification_pending)) ? 'verify'
          : row.state === 'failed' ? row.step : null;
    if (!['research','write','verify'].includes(step)) { if (row.state === 'failed') queue.failed++; continue; }
    if (Number(row.attempts?.[step] || 0) >= 3) { queue.failed++; continue; }
    if (row.retry_after && new Date(row.retry_after).getTime() > now) {
      queue[{ research: 'deferredResearch', write: 'deferredDrafting', verify: 'deferredVerification' }[step]]++;
      continue;
    }
    queue[{ research: 'researchIds', write: 'draftIds', verify: 'verifyIds' }[step]].push(Number(row.radar_item_id));
  }
  const remaining = Math.max(0, limit - queue.draftsCreated);
  queue.draftIds = queue.draftIds.slice(0, remaining);
  if (!remaining) { queue.researchIds = []; queue.deferredResearch = 0; queue.deferredDrafting = 0; }
  return queue;
}

export async function readCaseQueue(sql, runId, limit) {
  const rows = await sql`
    SELECT c.radar_item_id, c.state, c.step, c.attempts, c.lease_until, c.retry_after, a.status AS article_status,
      c.dossier #>> '{verification,pending}' AS verification_pending
    FROM editorial_cases c JOIN radar_items r ON r.id = c.radar_item_id
    LEFT JOIN articles a ON a.id = c.article_id
    WHERE c.run_id = ${Number(runId)} ORDER BY r.selection_rank ASC NULLS LAST, c.id
  `;
  return { ...caseQueue(rows, limit), selected: rows.length };
}
