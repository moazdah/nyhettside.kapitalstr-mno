// Operations watchdog. Short failures are handled by each job's five quick retries.
// This layer covers longer source/API outages: it revives exhausted jobs with
// widening pauses, opens one alert per problem, and resolves it on recovery.

export const REVIVABLE_KINDS = new Set(['breaking-enrichment']);
export const MAX_REVIVALS = 6; // 10, 20, 40, 80, 160, 320 minutes ≈ 10.5 hours in total
export const reviveDelayMinutes = revivals => 10 * 2 ** revivals;
export const SOURCE_OUTAGE_MINUTES = 20;
export const SCHEDULER_STALL_MINUTES = 12;

export function raiseAlert(sql, key, severity, title, details = {}) {
  return sql`INSERT INTO ops_alerts (alert_key, severity, title, details)
    VALUES (${key}, ${severity}, ${title}, ${JSON.stringify(details)}::jsonb)
    ON CONFLICT (alert_key) WHERE resolved_at IS NULL DO UPDATE SET last_seen_at = now(),
      occurrences = ops_alerts.occurrences + 1, details = EXCLUDED.details,
      severity = CASE WHEN EXCLUDED.severity = 'critical' THEN 'critical' ELSE ops_alerts.severity END,
      title = EXCLUDED.title,
      -- escalation from warning to critical is notified again
      notified_at = CASE WHEN EXCLUDED.severity = 'critical' AND ops_alerts.severity <> 'critical' THEN NULL ELSE ops_alerts.notified_at END`;
}

export function resolveAlerts(sql, prefix, keepKeys = []) {
  return sql`UPDATE ops_alerts SET resolved_at = now() WHERE resolved_at IS NULL
    AND alert_key LIKE ${prefix + '%'} AND NOT (alert_key = ANY(${keepKeys}::text[]))`;
}

const osloClock = now => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return { weekday: !['Sat', 'Sun'].includes(parts.find(p => p.type === 'weekday').value), hour: Number(parts.find(p => p.type === 'hour').value) };
};

export async function evaluateOps(sql, { now = new Date(), automationEnabled = true } = {}) {
  const summary = { revived: [], raised: [] };

  // 1. Sources failing for a long time (circuit breaker state from the watchers).
  const sources = await sql`SELECT source, consecutive_failures, first_failure_at, last_error, last_success_at FROM breaking_watch`;
  const failing = sources.filter(s => s.first_failure_at && now - new Date(s.first_failure_at) >= SOURCE_OUTAGE_MINUTES * 60000);
  for (const s of failing) {
    const minutes = Math.round((now - new Date(s.first_failure_at)) / 60000);
    await raiseAlert(sql, `source:${s.source}`, minutes >= 60 ? 'critical' : 'warning',
      `Kilden ${s.source} har feilet i ${minutes} minutter`, { failures: s.consecutive_failures, lastError: s.last_error, lastSuccess: s.last_success_at });
    summary.raised.push(`source:${s.source}`);
  }
  await resolveAlerts(sql, 'source:', failing.map(s => `source:${s.source}`));

  // 2. Jobs that used all quick retries: revive with widening pauses, then give up loudly.
  const exhausted = await sql`SELECT id, kind, slot, revivals, last_error, updated_at FROM engine_jobs
    WHERE status = 'failed' AND updated_at >= now() - interval '2 days'`;
  const openJobKeys = [];
  for (const job of exhausted) {
    const revivable = REVIVABLE_KINDS.has(job.kind) && Number(job.revivals) < MAX_REVIVALS;
    if (revivable) {
      openJobKeys.push(`job:${job.id}`);
      await raiseAlert(sql, `job:${job.id}`, 'warning', `Jobben ${job.kind} har brukt opp raske forsøk og prøves igjen senere`,
        { slot: job.slot, revivals: Number(job.revivals), lastError: job.last_error });
      if (now - new Date(job.updated_at) >= reviveDelayMinutes(Number(job.revivals)) * 60000) {
        await sql`UPDATE engine_jobs SET status = 'retry', attempts = 0, revivals = revivals + 1, retry_after = now(), updated_at = now()
          WHERE id = ${Number(job.id)} AND status = 'failed'`;
        summary.revived.push(Number(job.id));
      }
    } else {
      openJobKeys.push(`job:${job.id}`);
      await raiseAlert(sql, `job:${job.id}`, 'critical', `Alle forsøk er brukt opp for jobben ${job.kind}`,
        { slot: job.slot, revivals: Number(job.revivals), lastError: job.last_error });
      summary.raised.push(`job:${job.id}`);
    }
  }
  await resolveAlerts(sql, 'job:', openJobKeys);

  // 3. The scheduler itself stopped calling us during active hours.
  const clock = osloClock(now);
  const [tick] = await sql`SELECT max(started_at) AS last FROM scheduler_ticks WHERE route = 'fast-track'`;
  // The fast track runs on weekdays, 07–21 Oslo time is inside every season's window.
  const stalled = automationEnabled && clock.weekday && clock.hour >= 7 && clock.hour <= 21 && tick?.last && now - new Date(tick.last) >= SCHEDULER_STALL_MINUTES * 60000;
  if (stalled) {
    await raiseAlert(sql, 'scheduler:fast-track', 'critical', 'Hurtigsporet har ikke blitt kalt av tidsstyringen',
      { lastTick: tick.last });
    summary.raised.push('scheduler:fast-track');
  } else await resolveAlerts(sql, 'scheduler:', []);

  return summary;
}

// Sends new alerts once. Delivery channel: optional webhook (Slack/Teams/Discord
// compatible JSON) and the GitHub watchdog workflow, which fails and e-mails.
export async function notifyAlerts(sql, { fetcher = fetch, webhook = null } = {}) {
  const fresh = await sql`SELECT id, alert_key, severity, title, details, first_seen_at FROM ops_alerts
    WHERE resolved_at IS NULL AND notified_at IS NULL ORDER BY severity DESC, first_seen_at LIMIT 20`;
  if (!fresh.length) return { sent: [] };
  let error = null;
  if (webhook) {
    const text = fresh.map(a => `${a.severity === 'critical' ? '🔴' : '🟠'} ${a.title}`).join('\n');
    try {
      const response = await fetcher(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Kapitalstrøm drift:\n${text}`, content: `Kapitalstrøm drift:\n${text}` }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) error = `WEBHOOK_HTTP_${response.status}`;
    } catch (e) { error = String(e?.message || e).slice(0, 200); }
  }
  await sql`UPDATE ops_alerts SET notified_at = now(), notify_error = ${error} WHERE id = ANY(${fresh.map(a => Number(a.id))}::bigint[])`;
  return { sent: fresh.map(a => ({ key: a.alert_key, severity: a.severity, title: a.title })), error };
}

export async function recordTick(sql, route, scheduler, fn) {
  const [tick] = await sql`INSERT INTO scheduler_ticks (scheduler, route) VALUES (${scheduler}, ${route}) RETURNING id`;
  let ok = false, details = {};
  try { const result = await fn(); ok = result?.ok !== false; details = { published: result?.published?.length || 0, errors: result?.errors || [] }; return result; }
  catch (error) { details = { error: String(error?.message || error).slice(0, 300) }; throw error; }
  finally {
    try {
      await sql`UPDATE scheduler_ticks SET finished_at = now(), ok = ${ok}, details = ${JSON.stringify(details)}::jsonb WHERE id = ${Number(tick.id)}`;
      await sql`DELETE FROM scheduler_ticks WHERE started_at < now() - interval '14 days'`;
    } catch { /* measurement must never change the job's outcome */ }
  }
}

// Scheduling precision and source → visible latency, for admin and /api/health.
export async function latencyReport(sql) {
  const [events] = await sql`SELECT count(*)::int AS count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE(visible_verified_at, first_published_at) - source_published_at))) AS median_seconds,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE(visible_verified_at, first_published_at) - source_published_at))) AS p90_seconds,
      max(EXTRACT(EPOCH FROM (COALESCE(visible_verified_at, first_published_at) - source_published_at))) AS max_seconds
    FROM breaking_events WHERE first_published_at IS NOT NULL AND source_published_at >= now() - interval '30 days'`;
  const [gaps] = await sql`WITH t AS (SELECT started_at, EXTRACT(EPOCH FROM (started_at - lag(started_at) OVER (ORDER BY started_at))) AS gap
      FROM scheduler_ticks WHERE route = 'fast-track' AND started_at >= now() - interval '24 hours')
    SELECT count(*)::int AS ticks, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap_seconds,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY gap) AS p95_gap_seconds, max(gap) AS max_gap_seconds, max(started_at) AS last_tick FROM t`;
  const round = v => v == null ? null : Math.round(Number(v));
  return { sourceToVisible: { events: events?.count || 0, medianSeconds: round(events?.median_seconds), p90Seconds: round(events?.p90_seconds), maxSeconds: round(events?.max_seconds) },
    scheduler: { ticks24h: gaps?.ticks || 0, medianGapSeconds: round(gaps?.median_gap_seconds), p95GapSeconds: round(gaps?.p95_gap_seconds),
      maxGapSeconds: round(gaps?.max_gap_seconds), lastTick: gaps?.last_tick || null } };
}
