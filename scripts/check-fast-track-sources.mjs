// Read-only live check of the fast-track parsers against the real official sources.
import assert from 'node:assert/strict';
import { SSB_API, SSB_RELEASES, buildQuery, latestTwo, monthLabel, assertCurrent } from '../lib/breaking/ssb.mjs';
import { COMPANY_NEWS_URL, parseCompanyNews, classifyNotice } from '../lib/breaking/oslo-bors.mjs';
import { NB_FEED, fetchOfficial } from '../lib/breaking/norges-bank.mjs';

const report = { ok: true, checks: {} };
async function check(name, fn) {
  try { report.checks[name] = { ok: true, ...(await fn()) }; }
  catch (error) { report.ok = false; report.checks[name] = { ok: false, error: String(error.message).slice(0, 300) }; }
}
const json = async (url, init = {}) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
  assert.ok(r.ok, `HTTP_${r.status}`); return r.json();
};

for (const release of SSB_RELEASES) for (const spec of release.series) {
  await check(`ssb:${spec.id}`, async () => {
    const metadata = await json(SSB_API + spec.table);
    const query = buildQuery(metadata, spec);
    const latest = latestTwo(await json(SSB_API + spec.table, { method: 'POST', body: JSON.stringify(query) }), spec);
    monthLabel(latest.period); assertCurrent(latest);
    return { query: query.query.map(q => `${q.code}=${q.selection.values.join(',')}`), latest };
  });
}
await check('norges-bank:feed', async () => {
  const xml = await fetchOfficial(NB_FEED, 'application/rss+xml, application/xml, text/xml');
  assert.match(xml, /<item\b/i); return { items: (xml.match(/<item\b/gi) || []).length };
});
await check('oslo-bors:list', async () => {
  const rows = parseCompanyNews(await fetchOfficial(COMPANY_NEWS_URL));
  assert.ok(rows.length > 0, 'NO_ROWS');
  assert.equal(rows.filter(r => r.url).length, rows.length, 'ROWS_WITHOUT_RELEASE_ID');
  const r = await fetch(rows[0].textUrl, { signal: AbortSignal.timeout(15000) });
  assert.ok(r.ok, 'RELEASE_TEXT_HTTP_' + r.status);
  const text = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(text.includes(rows[0].title.slice(0, 20)), 'RELEASE_TEXT_MISMATCH');
  return { rows: rows.length, withUrl: rows.filter(r => r.url).length, releaseTextLength: text.length, sample: rows.slice(0, 5).map(r => ({ company: r.company, title: r.title, category: r.category, at: r.publishedAt, fastTrack: classifyNotice(r)?.kind || null })) };
});
console.log(JSON.stringify(report, null, 1));
if (!report.ok) process.exitCode = 1;
