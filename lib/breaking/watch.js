import { db } from '../db';
import { SITE_URL } from '../site';
import { NB_FEED, decisionLinks, parseDecision, fetchOfficial } from './norges-bank.mjs';
import { detectSsbReleases } from './ssb.mjs';
import { COMPANY_NEWS_URL, parseCompanyNews, noticeFlash } from './oslo-bors.mjs';
import { publishFlash } from './store.mjs';
import { selectImageForArticle } from '../media/images';

const osloClock = now => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return { weekday: !['Sat', 'Sun'].includes(parts.find(p => p.type === 'weekday').value), hour: Number(parts.find(p => p.type === 'hour').value) };
};

// Every official fast-track source, its watch window (Oslo time) and detector.
// A detector returns candidate flashes; publication is shared and idempotent.
export const FAST_TRACK_SOURCES = [
  { source: 'norges-bank', hours: [7, 18], async detect({ now }) {
    const links = decisionLinks(await fetchOfficial(NB_FEED, 'application/rss+xml, application/xml, text/xml'), now);
    return { candidates: links.slice(0, 2).map(link => ({ url: link.url, load: async () => parseDecision(await fetchOfficial(link.url), { ...link, now }) })) };
  } },
  { source: 'ssb', hours: [7, 17], async detect({ now, state }) {
    const result = await detectSsbReleases({ state, now });
    return { candidates: result.found.map(flash => ({ url: flash.url, storyKey: flash.storyKey, load: async () => flash })), state: result.state };
  } },
  { source: 'oslo-bors', hours: [6, 23], async detect({ now }) {
    const rows = parseCompanyNews(await fetchOfficial(COMPANY_NEWS_URL));
    if (!rows.length) throw new Error('OSLO_BORS_LIST_EMPTY');
    const flashes = rows.map(row => noticeFlash(row, { now })).filter(Boolean).slice(0, 4);
    return { candidates: flashes.map(flash => ({ url: flash.url, storyKey: flash.storyKey, load: async () => flash })) };
  } },
];

const BACKOFF_MS = failures => Math.min(5 * 60000, 20000 * 2 ** Math.max(0, failures - 1));

async function recordSuccess(sql, source, state) {
  await sql`INSERT INTO breaking_watch(source,checked_at,last_success_at,state) VALUES(${source},now(),now(),${JSON.stringify(state || {})}::jsonb)
    ON CONFLICT(source) DO UPDATE SET checked_at=now(),last_success_at=now(),last_error=NULL,consecutive_failures=0,
      first_failure_at=NULL,next_attempt_at=NULL,state=COALESCE(${state ? JSON.stringify(state) : null}::jsonb,breaking_watch.state)`;
}
async function recordFailure(sql, source, error, failures) {
  const message = String(error?.message || error).slice(0, 500);
  await sql`INSERT INTO breaking_watch(source,checked_at,last_error,consecutive_failures,first_failure_at,next_attempt_at)
    VALUES(${source},now(),${message},1,now(),now()+${BACKOFF_MS(1) / 1000}*interval '1 second')
    ON CONFLICT(source) DO UPDATE SET checked_at=now(),last_error=EXCLUDED.last_error,
      consecutive_failures=breaking_watch.consecutive_failures+1,
      first_failure_at=COALESCE(breaking_watch.first_failure_at,now()),
      next_attempt_at=now()+${BACKOFF_MS(failures + 1) / 1000}*interval '1 second'`;
}

// Public pages are dynamic, so a committed flash is visible on the next request.
// In production we still confirm it over HTTP to measure source → visible.
async function verifyVisible(sql, published, fetcher) {
  if (process.env.VERCEL_ENV !== 'production') return;
  for (const flash of published) {
    try {
      const response = await fetcher(`${SITE_URL}/artikkel/${flash.slug}`, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (response.ok) await sql`UPDATE breaking_events SET visible_verified_at=COALESCE(visible_verified_at,now()) WHERE id=${Number(flash.id)}`;
    } catch { /* measurement only; never blocks publication */ }
  }
}

async function runSource(sql, entry, { now, force }) {
  const [watch] = await sql`SELECT * FROM breaking_watch WHERE source=${entry.source}`;
  const clock = osloClock(new Date(now));
  if (!force && (!clock.weekday || clock.hour < entry.hours[0] || clock.hour > entry.hours[1])) return { source: entry.source, skipped: 'outside_window' };
  if (!force && watch?.next_attempt_at && new Date(watch.next_attempt_at) > new Date(now)) return { source: entry.source, skipped: 'backoff', failures: watch.consecutive_failures };
  try {
    const detected = await entry.detect({ now, state: watch?.state || {} });
    const published = [];
    for (const candidate of detected.candidates) {
      const [existing] = await sql`SELECT id FROM breaking_events WHERE source_url=${candidate.url}
        OR (${candidate.storyKey || null}::text IS NOT NULL AND story_key=${candidate.storyKey || null})`;
      if (existing) continue;
      const flash = await candidate.load();
      const row = await publishFlash(sql, flash);
      if (row) published.push({ ...row, headline: flash.headline });
    }
    await recordSuccess(sql, entry.source, detected.state);
    return { source: entry.source, checked: true, published };
  } catch (error) {
    await recordFailure(sql, entry.source, error, Number(watch?.consecutive_failures || 0));
    return { source: entry.source, error: String(error?.message || error).slice(0, 300) };
  }
}

export async function watchFastTrack({ sql = db(), now = Date.now(), only = null, force = false, fetcher = fetch } = {}) {
  const [settings] = await sql`SELECT automation_enabled,auto_publish_enabled,breaking_publish_enabled FROM editorial_settings WHERE id=1`;
  if (!settings?.automation_enabled || !settings.auto_publish_enabled || !settings.breaking_publish_enabled) return { skipped: true, reason: 'disabled' };
  const entries = FAST_TRACK_SOURCES.filter(entry => !only || only.includes(entry.source));
  const sources = await Promise.all(entries.map(entry => runSource(sql, entry, { now, force })));
  const published = sources.flatMap(s => s.published || []);
  // Images are a secondary step: a flash is never delayed or blocked by them.
  for (const flash of published) {
    try { await selectImageForArticle(sql, flash.article_id); } catch { /* fallback visual is used */ }
  }
  await verifyVisible(sql, published, fetcher);
  return { checked: true, published, sources, errors: sources.filter(s => s.error).map(s => `${s.source}: ${s.error}`) };
}
