import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { database, application } from './helpers/runtime.mjs';
import { assessStory, currentRank } from '../lib/desk/priority.mjs';
import { sameStory, matchStory, storySimilarity } from '../lib/desk/stories.mjs';
import { factSummary, normalizeSummary } from '../lib/desk/summary.mjs';
import { buildQuery, latestTwo, releaseFlash, detectSsbReleases, SSB_RELEASES } from '../lib/breaking/ssb.mjs';
import { parseCompanyNews, classifyNotice, noticeFlash } from '../lib/breaking/oslo-bors.mjs';
import { publishFlash } from '../lib/breaking/store.mjs';
import { evaluateOps, notifyAlerts, MAX_REVIVALS, reviveDelayMinutes } from '../lib/ops/alerts.mjs';

const now = Date.parse('2026-09-10T06:02:00Z');

test('Desk priority: official rate decision leads with banner; weak foreign item stays off the rail', () => {
  const rate = assessStory({ title: 'Norges Bank hever styringsrenten til 4,50 prosent', kind: 'rate-decision', sourceKey: 'norges-bank',
    publishedAt: new Date(now - 60000).toISOString(), fastTrack: true }, { now });
  assert.equal(rate.placement, 'lead'); assert.equal(rate.banner, true); assert.equal(rate.live, true);
  const weak = assessStory({ title: 'Micron shares edge higher in quiet trading', aiScore: 55, publishedAt: new Date(now - 8 * 3600000).toISOString() }, { now });
  assert.equal(weak.placement, 'standard'); assert.equal(weak.live, false); assert.equal(weak.banner, false);
  const regular = assessStory({ title: 'Equinor inngår milliardkontrakt', candidateType: 'kontrakt', aiScore: 78, publishedAt: new Date(now - 30 * 60000).toISOString() }, { now });
  assert.ok(regular.score > weak.score && regular.score < rate.score);
  assert.equal(regular.banner, false, 'regular articles never interrupt with the banner');
  // Several sources on the same event raise news value.
  assert.ok(assessStory({ title: 'Equinor inngår milliardkontrakt', aiScore: 78, sourceCount: 3, publishedAt: new Date(now).toISOString() }, { now }).newsValue
    > assessStory({ title: 'Equinor inngår milliardkontrakt', aiScore: 78, publishedAt: new Date(now).toISOString() }, { now }).newsValue);
  assert.ok(currentRank({ priority: 90, publishedAt: new Date(now - 10 * 3600000) }, now) < currentRank({ priority: 80, publishedAt: new Date(now) }, now));
});

test('Stories: same event from several sources is merged; contradictory figures are not', () => {
  const at = new Date(now).toISOString();
  assert.ok(sameStory({ title: 'Norges Bank hever styringsrenten til 4,50 prosent', publishedAt: at }, { title: 'Norges Bank øker renten til 4,50 prosent', publishedAt: at }));
  assert.equal(sameStory({ title: 'Norges Bank hever renten til 4,50 prosent', publishedAt: at }, { title: 'Norges Bank hever renten til 4,75 prosent', publishedAt: at }), false);
  assert.equal(sameStory({ title: 'Norges Bank hever renten', publishedAt: at }, { title: 'Norges Bank hever renten', publishedAt: new Date(now - 3 * 86400000).toISOString() }), false);
  assert.ok(storySimilarity('Equinor opened a field', 'Norges Bank senker renten') < 0.3);
  const stories = [{ id: 7, title: 'Prisveksten var 3,1 prosent i august', published_at: at }];
  assert.equal(matchStory({ title: 'KPI: Prisveksten steg til 3,1 prosent i august', published_at: at }, stories)?.id, 7);
  assert.equal(matchStory({ title: 'Equinor kutter utbyttet', published_at: at }, stories), null);
});

test('Summary: only research-verified facts, attributed when needed, never the AI assessment', () => {
  const url = 'https://example.com/a';
  const points = factSummary({ facts: [
    { id: 'F1', fact: 'Equinor har inngått en kontrakt verdt 2 milliarder kroner.', evidence_quote: 'kontrakt verdt 2 milliarder', source_url: url },
    { id: 'F2', fact: 'Equinor har inngått en kontrakt verdt 2 milliarder kroner.', evidence_quote: 'dup', source_url: url },
    { id: 'F3', fact: 'Uten kildeutdrag', evidence_quote: '', source_url: url },
    { id: 'F4', fact: 'Leveransene starter i 2027', evidence_quote: 'starter i 2027', source_url: url, attribution_needed: true, source_name: 'E24' },
  ] });
  assert.deepEqual(points.map(p => p.text), ['Equinor har inngått en kontrakt verdt 2 milliarder kroner.', 'Leveransene starter i 2027, ifølge E24.']);
  assert.ok(points.every(p => p.kind === 'fact' && p.source_url));
  assert.deepEqual(normalizeSummary(['Gammel streng']).map(p => p.kind), ['fact']);
});

const ssbMetadata = { variables: [
  { code: 'Konsumgrp', values: ['TOTAL', '01'], valueTexts: ['Totalindeks', 'Matvarer og alkoholfrie drikkevarer'], elimination: true },
  { code: 'ContentsCode', values: ['KpiIndMnd', 'Tolvmanedersendring'], valueTexts: ['Konsumprisindeks (2015=100)', '12-måneders endring (prosent)'] },
  { code: 'Tid', values: ['2026M07', '2026M08'], valueTexts: ['2026M07', '2026M08'], time: true }] };
const ssbData = (values = [3.0, 3.1], updated = '2026-09-10T06:00:00Z', periods = ['2026M07', '2026M08']) => ({ class: 'dataset', updated, id: ['Konsumgrp', 'ContentsCode', 'Tid'], size: [1, 1, 2],
  dimension: { Konsumgrp: { category: { index: { TOTAL: 0 } } }, ContentsCode: { category: { index: { Tolvmanedersendring: 0 } } },
    Tid: { category: { index: { [periods[0]]: 0, [periods[1]]: 1 } } } }, value: values });

test('SSB: codes are discovered from labels; flash states only the published figures', () => {
  const spec = SSB_RELEASES[0].series[0];
  const query = buildQuery(ssbMetadata, spec);
  assert.deepEqual(query.query.map(q => q.selection.values[0]), ['TOTAL', 'Tolvmanedersendring', '2']);
  const figure = latestTwo(ssbData(), spec);
  assert.equal(figure.period, '2026M08'); assert.equal(figure.previousValue, 3);
  const flash = releaseFlash(SSB_RELEASES[0], [figure], { now });
  assert.equal(flash.headline, 'Prisveksten var 3,1 prosent i august');
  assert.match(flash.fact, /steg 3,1 prosent de siste tolv månedene til august 2026, opp fra 3 prosent måneden før, viser tall fra SSB\./);
  assert.equal(flash.storyKey, 'ssb:kpi:2026M08'); assert.equal(flash.enrich, false);
  assert.throws(() => releaseFlash(SSB_RELEASES[0], [figure], { now: now + 5 * 3600000 }), /NOT_FRESH/);
  assert.match(releaseFlash(SSB_RELEASES[0], [latestTwo(ssbData([0.2, -0.4]), spec)], { now }).fact, /falt 0,4 prosent.*ned fra 0,2/);
  assert.throws(() => buildQuery({ variables: [{ code: 'Tid', values: ['x'], valueTexts: ['x'], time: true }, { code: 'ContentsCode', values: ['A'], valueTexts: ['Indeks'] }] }, spec), /TWELVE_MONTH_MISSING/);
});

function ssbFetcher(data) {
  return async (url, init = {}) => new Response(JSON.stringify(init.method === 'POST' ? data : ssbMetadata), { status: 200 });
}
test('SSB: stale data on first run is remembered but not published; a new period is published once', async () => {
  const first = await detectSsbReleases({ state: {}, now: now + 2 * 86400000, fetcher: ssbFetcher(ssbData()) });
  assert.equal(first.found.length, 0); assert.equal(first.state.kpi.period, '2026M08');
  const same = await detectSsbReleases({ state: first.state, now, fetcher: ssbFetcher(ssbData()) });
  assert.equal(same.found.length, 0);
  const next = await detectSsbReleases({ state: first.state, now: Date.parse('2026-10-10T06:01:00Z'),
    fetcher: ssbFetcher(ssbData([3.1, 2.8], '2026-10-10T06:00:00Z', ['2026M08', '2026M09'])) });
  assert.equal(next.found.length, 1); assert.equal(next.found[0].headline, 'Prisveksten var 2,8 prosent i september');
});

const bors = `<table><tr><td>10 Sep 2026 07:00 CEST</td><td>EQUINOR ASA</td><td><a href="/en/listview/company-press-release/111">Equinor third quarter 2026 results</a></td><td>Energy</td><td>Half yearly financial reports and audit reports</td></tr>
<tr><td>10 Sep 2026 07:05 CEST</td><td>DNB BANK ASA</td><td><a href="/en/listview/company-press-release/112">Invitation to presentation of third quarter results</a></td><td>Banks</td><td>Non-regulatory press releases</td></tr>
<tr><td>10 Sep 2026 07:06 CEST</td><td>LITEN SMÅ ASA</td><td><a href="/en/listview/company-press-release/113">Q3 2026 results</a></td><td>Tech</td><td>Inside information</td></tr>
<tr><td>10 Sep 2026 07:10 CEST</td><td>KONGSBERG GRUPPEN ASA</td><td><a href="/en/listview/company-press-release/114">Kongsberg awarded NOK 5 billion contract</a></td><td>Defence</td><td>Inside information</td></tr>
<tr><td>10 Sep 2026 07:12 CEST</td><td>MOWI ASA</td><td><a href="/en/listview/company-press-release/115">Mandatory notification of trade - primary insider</a></td><td>Seafood</td><td>Inside information</td></tr></table>`;
test('Oslo Børs: large-cap results and material notices take the fast track; invitations, insiders and small caps do not', () => {
  const rows = parseCompanyNews(bors);
  assert.equal(rows.length, 5); assert.equal(rows[0].publishedAt.toISOString(), '2026-09-10T05:00:00.000Z');
  assert.deepEqual(rows.map(r => classifyNotice(r)?.kind || null), ['exchange-results', null, null, 'exchange-notice', null]);
  const flash = noticeFlash(rows[0], { now: Date.parse('2026-09-10T05:00:40Z') });
  assert.equal(flash.headline, 'Equinor har lagt fram tall: «Equinor third quarter 2026 results»');
  assert.equal(flash.url, 'https://live.euronext.com/en/listview/company-press-release/111');
  assert.equal(noticeFlash(rows[0], { now: Date.parse('2026-09-10T08:00:00Z') }), null, 'old announcements are not flashed');
});

async function setup(options = {}) {
  const d = await database(), app = application(d.sql, options);
  await (await app.load('lib/autopilot/editorial-settings.js')).getEditorialSettings(d.sql);
  await d.pg.exec('CREATE TABLE feed(id bigserial primary key,tekst text,seksjon text,status text,tidspunkt timestamptz DEFAULT now());');
  await (await app.load('lib/live-update-schema.js')).ensureLiveUpdateSchema(d.sql);
  for (const file of ['002_news_engine.sql', '003_breaking_desk.sql', '004_newsroom_desk.sql']) await d.pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  await d.sql`UPDATE editorial_settings SET breaking_publish_enabled=true WHERE id=1`;
  return { ...d, app };
}

test('Fast-track publication: SSB release is placed by the desk, has no enrichment job and is idempotent by story', async () => {
  const d = await setup();
  try {
    const figure = latestTwo(ssbData(), SSB_RELEASES[0].series[0]);
    const flash = releaseFlash(SSB_RELEASES[0], [figure], { now: Date.parse(figure.updated) + 30000 });
    const a = await publishFlash(d.sql, flash), b = await publishFlash(d.sql, { ...flash, url: flash.url + '&x=1' });
    assert.ok(a.article_id); assert.equal(b, undefined, 'a second URL for the same story key is not a new story');
    const [article] = await d.sql`SELECT * FROM articles`;
    assert.equal(article.story_key, 'ssb:kpi:2026M08'); assert.ok(Number(article.priority_score) >= 82); assert.equal(article.placement, 'lead');
    assert.ok(article.breaking_until, 'lead fast-track gets the banner');
    assert.equal((await d.sql`SELECT * FROM engine_jobs`).length, 0);
    assert.equal((await d.sql`SELECT * FROM article_sources`).length, 1);
    assert.equal((await d.sql`SELECT * FROM feed WHERE status='live'`).length, 1);
  } finally { await d.pg.close(); }
});

test('Fast-track watcher: one failing source backs off and is reported without blocking the others', async () => {
  const fetcher = async url => {
    if (String(url).startsWith('https://data.ssb.no/')) return new Response('down', { status: 503 });
    if (String(url).includes('norges-bank')) return new Response('<rss></rss>', { status: 200 });
    if (String(url).includes('company-news')) return new Response(bors.replace('LITEN', 'X'), { status: 200 });
    throw new Error('unexpected ' + url);
  };
  const d = await setup({ fetcher });
  try {
    const watch = await d.app.load('lib/breaking/watch.js');
    const first = await watch.watchFastTrack({ sql: d.sql, now: Date.parse('2026-09-10T05:11:00Z'), fetcher });
    const ssb = first.sources.find(s => s.source === 'ssb');
    assert.match(ssb.error, /SSB_HTTP_503/);
    assert.deepEqual(JSON.parse(JSON.stringify(first.published.map(p => p.headline).sort())), ['Equinor har lagt fram tall: «Equinor third quarter 2026 results»',
      'Kongsberg Gruppen i børsmelding: «Kongsberg awarded NOK 5 billion contract»']);
    const second = await watch.watchFastTrack({ sql: d.sql, now: Date.parse('2026-09-10T05:11:05Z'), fetcher });
    assert.equal(second.sources.find(s => s.source === 'ssb').skipped, 'backoff');
    assert.equal(second.published.length, 0, 'replays never duplicate');
    const [state] = await d.sql`SELECT * FROM breaking_watch WHERE source='ssb'`;
    assert.equal(state.consecutive_failures, 1);
    assert.equal((await d.sql`SELECT * FROM engine_jobs WHERE kind='breaking-enrichment'`).length, 2);
  } finally { await d.pg.close(); }
});

test('Images: editor library first, licensed Commons file accepted, restricted or unlicensed files rejected, otherwise fallback', async () => {
  const commons = (license, restrictions = '') => ({ query: { pages: { 1: { index: 1, title: 'File:Norges Bank.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/nb.jpg',
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Norges_Bank.jpg', mime: 'image/jpeg', width: 3000,
    extmetadata: { LicenseShortName: { value: license }, Artist: { value: '<a href="x">Ola Nordmann</a>' }, Restrictions: { value: restrictions } } }] } } } });
  let response = commons('CC BY-SA 4.0');
  const d = await setup({ fetcher: async () => new Response(JSON.stringify(response), { status: 200 }) });
  try {
    const images = await d.app.load('lib/media/images.js');
    const insert = title => d.sql`INSERT INTO articles(slug,tittel,brodtekst,status) VALUES(${title},${title},'x','live') RETURNING id`;
    const [a] = await insert('Norges Bank holder renten uendret');
    assert.equal((await images.selectImageForArticle(d.sql, a.id)).status, 'selected');
    const [row] = await d.sql`SELECT * FROM articles WHERE id=${a.id}`;
    assert.equal(row.bilde_kreditt, 'Foto: Ola Nordmann / Wikimedia Commons (CC BY-SA 4.0)'); assert.equal(row.image_license, 'CC BY-SA 4.0');
    await d.sql`UPDATE image_library SET active=false`;
    response = commons('Fair use');
    const [b] = await insert('Norges Bank kjøper valuta');
    assert.equal((await images.selectImageForArticle(d.sql, b.id)).status, 'fallback');
    response = commons('CC BY 4.0', 'trademarked');
    assert.equal((await images.selectImageForArticle(d.sql, b.id)).status, 'fallback');
    await d.sql`INSERT INTO image_library(url,credit,license,alt,tags) VALUES('https://img/editor.jpg','Foto: Kapitalstrøm','Egen','Norges Bank',ARRAY['norges-bank'])`;
    assert.equal((await images.selectImageForArticle(d.sql, b.id)).url, 'https://img/editor.jpg');
    const [c] = await insert('Uklart tema uten motiv');
    assert.equal((await images.selectImageForArticle(d.sql, c.id)).status, 'fallback');
    await d.sql`UPDATE articles SET bilde_url='https://img/manual.jpg' WHERE id=${c.id}`;
    assert.equal((await images.selectImageForArticle(d.sql, c.id)).status, 'kept', 'editor choices are never replaced');
  } finally { await d.pg.close(); }
});

test('Operations: exhausted jobs are revived with widening pauses, then alert critically; long source outages alert once', async () => {
  const d = await setup();
  try {
    await d.sql`INSERT INTO engine_jobs(kind,slot,status,attempts,last_error,updated_at) VALUES('breaking-enrichment','event:1','failed',5,'provider down',now()-interval '11 minutes')`;
    let result = await evaluateOps(d.sql, { now: new Date() });
    assert.equal(result.revived.length, 1);
    let [job] = await d.sql`SELECT * FROM engine_jobs`;
    assert.equal(job.status, 'retry'); assert.equal(job.attempts, 0); assert.equal(job.revivals, 1);
    assert.equal(reviveDelayMinutes(1), 20);
    await d.sql`UPDATE engine_jobs SET status='failed',revivals=${MAX_REVIVALS},updated_at=now()`;
    await evaluateOps(d.sql, { now: new Date() });
    [job] = await d.sql`SELECT * FROM engine_jobs`; assert.equal(job.status, 'failed');
    await d.sql`INSERT INTO breaking_watch(source,checked_at,consecutive_failures,first_failure_at,last_error) VALUES('ssb',now(),30,now()-interval '70 minutes','SSB_HTTP_503')`;
    await evaluateOps(d.sql, { now: new Date() });
    const alerts = await d.sql`SELECT alert_key,severity FROM ops_alerts WHERE resolved_at IS NULL ORDER BY alert_key`;
    assert.deepEqual(alerts.map(a => [a.alert_key, a.severity]), [['job:1', 'critical'], ['source:ssb', 'critical']]);
    const posted = [];
    const sent = await notifyAlerts(d.sql, { webhook: 'https://hooks.example/x', fetcher: async (url, init) => { posted.push(JSON.parse(init.body)); return new Response('ok'); } });
    assert.equal(sent.sent.length, 2); assert.match(posted[0].text, /Alle forsøk er brukt opp/);
    assert.equal((await notifyAlerts(d.sql, { webhook: null })).sent.length, 0, 'each alert is delivered once');
    await d.sql`UPDATE breaking_watch SET consecutive_failures=0,first_failure_at=NULL`;
    await d.sql`UPDATE engine_jobs SET status='done'`;
    await evaluateOps(d.sql, { now: new Date() });
    assert.equal((await d.sql`SELECT * FROM ops_alerts WHERE resolved_at IS NULL`).length, 0, 'recovery resolves alerts');
  } finally { await d.pg.close(); }
});
