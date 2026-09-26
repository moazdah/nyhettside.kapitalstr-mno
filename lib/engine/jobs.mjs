import { randomUUID } from 'node:crypto';

export async function enqueue(sql, kind, slot, payload = {}) {
  const [job] = await sql`INSERT INTO engine_jobs(kind,slot,payload) VALUES(${kind},${slot},${JSON.stringify(payload)}::jsonb)
    ON CONFLICT(kind,slot) DO UPDATE SET slot=EXCLUDED.slot RETURNING *`;
  return job;
}
export async function claim(sql, id) {
  const [job] = await sql`SELECT * FROM engine_claim(${Number(id)},${randomUUID()}::uuid)`;
  return job || null;
}
export function guard(sql, job) {
  return sql`SELECT engine_assert_lease(${Number(job.id)},${job.lease_token}::uuid)`;
}
export async function checkpoint(sql, job, payload, { done = false, delay = 0, writes = [], errorMessage = null } = {}) {
  await sql.transaction([guard(sql, job), ...writes,
    sql`UPDATE engine_jobs SET status=${done ? 'done' : 'pending'}, payload=${JSON.stringify(payload)}::jsonb,
      attempts=0, lease_token=NULL, lease_until=NULL, retry_after=now()+${delay}*interval '1 second',
      last_error=COALESCE(${errorMessage},last_error),
      finished_at=CASE WHEN ${done} THEN now() ELSE NULL END, updated_at=now()
      WHERE id=${Number(job.id)}`]);
}
export async function fail(sql, job, error, writes = []) {
  await sql.transaction([guard(sql, job), ...writes,
    sql`UPDATE engine_jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'retry' END,
      last_error=${String(error?.message || error).slice(0,800)}, lease_token=NULL, lease_until=NULL,
      retry_after=now()+LEAST(300,30*attempts)*interval '1 second', updated_at=now() WHERE id=${Number(job.id)}`]);
}
export async function nextJob(sql, kind) {
  const [job] = await sql`SELECT * FROM engine_jobs WHERE kind=${kind} AND status IN ('pending','retry','running')
    AND (lease_until IS NULL OR lease_until<=now()) AND (retry_after IS NULL OR retry_after<=now())
    ORDER BY created_at,id LIMIT 1`;
  return job || null;
}
