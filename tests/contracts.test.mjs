import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAudience, assessResearch, assessVerification, publicationEvidence, publicationGate, ageReasons, canonicalSourceUrl } from '../lib/editorial/contract.mjs';
import { sourceRoleFromUrl, isPublicAddress, fetchSourceDocumentBytes } from '../lib/editorial/source-policy.mjs';
import { caseQueue } from '../lib/editorial/queue.mjs';
import { fixture, sourceUrl } from './helpers/fixtures.mjs';

for (const [title, eligible] of [
  ['Norges Bank senker renten', true], ['Equinor inngår kontrakt på 2 milliarder', true],
  ['DNB løfter resultatet', true], ['Brent oil surges after OPEC cuts', true],
  ['Nvidia raises revenue guidance', true], ['Bitcoin faller kraftig', true],
  ['Tiny US widget company reports earnings', false], ['Best stocks to buy now: Nvidia', false],
  ['Equinor inviterer til sommerfest', false], ['Kjendis åpner restaurant', false],
]) test(`Audience: ${title}`, () => assert.equal(assessAudience({ title }).eligible, eligible));

for (const [name, html, expected] of [
  ['explicit published metadata', '<meta property="article:published_time" content="2026-09-20T10:30:00+02:00">', '2026-09-20T08:30:00.000Z'],
  ['article JSON-LD', '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-09-20T08:30:00Z"}</script>', '2026-09-20T08:30:00.000Z'],
  ['modified is not published', '<meta property="article:modified_time" content="2026-09-20T10:30:00Z">', null],
  ['generic time is not evidence', '<time datetime="2026-09-20T10:30:00Z">I dag</time>', null],
  ['date without time is not a verified timestamp', '<meta itemprop="datePublished" content="2026-09-20">', null],
  ['conflicting dates stop research', '<meta itemprop="datePublished" content="2026-09-20T10:30:00Z"><meta property="article:published_time" content="2026-09-19T10:30:00Z">', null],
  ['invalid calendar day', '<meta itemprop="datePublished" content="2026-02-31T10:30:00Z">', null],
]) test(`Publication evidence: ${name}`, () => assert.equal(publicationEvidence(html)?.at || null, expected));

for (const [name, mutate, reason] of [
  ['valid official evidence', () => {}, null],
  ['discovery snippet without fetched document', f => { f.documents[0].fetched = false; }, 'source_not_verified'],
  ['calendar instead of decision', f => { f.documents[0].documentType = 'index'; }, 'source_is_index'],
  ['old original discovered today', f => { f.documents[0].publication.at = new Date(Date.now() - 37 * 3600000).toISOString(); }, 'event_expired'],
  ['unknown original date', f => { f.documents[0].publication = null; }, 'original_date_unverified'],
  ['future publication', f => { f.documents[0].publication.at = new Date(Date.now() + 3600000).toISOString(); }, 'original_date_in_future'],
  ['research declines writing', f => { f.pack.canWrite = false; }, 'research_declined'],
  ['different event', f => { f.pack.matchesEvent = false; }, 'event_mismatch'],
  ['invented quote', f => { f.pack.facts[0].evidence_quote = 'Equinor dobler resultatet etter skatt.'; }, 'evidence_missing:1'],
  ['invented source URL', f => { f.pack.facts[0].source_url = 'https://equinor.com/nonexistent'; }, 'evidence_missing:1'],
  ['headline without supporting fact', f => { f.pack.headlineFactIds = ['F99']; }, 'headline_evidence_missing'],
  ['high AI score without audience relevance', f => { f.dossier.selection.eligible = false; }, 'audience_relevance_missing'],
]) test(`Research gate: ${name}`, () => {
  const f = fixture(); mutate(f);
  const result = assessResearch(f.dossier, f.pack, f.documents);
  assert.equal(result.passed, reason === null);
  if (reason) assert.ok(result.reasons.includes(reason), result.reasons.join(','));
});

for (const [name, mutate, passed] of [
  ['every block supported', () => {}, true],
  ['reviewer declines', f => { f.response.passed = false; }, false],
  ['headline omitted', f => { f.response.checks.shift(); }, false],
  ['wrong company or currency detected', f => { f.response.checks[0].entity_numbers_units_dates_match = false; }, false],
  ['unsupported fact reference', f => { f.response.checks[0].fact_ids = ['F99']; }, false],
  ['duplicate block hides missing block', f => { f.response.checks[1] = f.response.checks[0]; }, false],
  ['investment advice check omitted', f => { delete f.response.personal_advice; }, false],
  ['personal investment advice', f => { f.response.personal_advice = true; }, false],
]) test(`Draft review: ${name}`, () => {
  const f = fixture(); mutate(f);
  assert.equal(assessVerification(f.draft, f.snapshot, f.response).passed, passed);
});

test('Publication rejects changed draft, changed fact pack and expired evidence', () => {
  const f = fixture();
  assert.equal(publicationGate(f.dossier, f.article, f.snapshot).passed, true);
  assert.ok(publicationGate(f.dossier, { ...f.article, tittel: 'Endret tittel' }, f.snapshot).reasons.includes('draft_changed'));
  assert.ok(publicationGate(f.dossier, f.article, { ...f.snapshot, confidence: 99 }).reasons.includes('fact_pack_changed'));
  assert.ok(publicationGate(f.dossier, f.article, f.snapshot, { now: Date.now() + 37 * 3600000 }).reasons.includes('event_expired'));
});

test('Unknown /news path and lookalike domains never become primary sources', () => {
  for (const url of ['https://random.example/news/announcement', 'https://equinor.com.evil.example/news/x', 'https://www.equinor.com@evil.example/news/x', 'http://equinor.com/news/x']) {
    assert.equal(sourceRoleFromUrl(url, { title: 'Equinor' }).role, 'unknown');
  }
  assert.equal(sourceRoleFromUrl(sourceUrl, { title: 'Equinor inngår kontrakt' }).role, 'primary');
  assert.equal(sourceRoleFromUrl(sourceUrl, { title: 'DNB inngår kontrakt' }).role, 'unknown');
});

test('Private DNS and redirect destinations are rejected before fetching content', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','172.16.0.1','::1','::ffff:127.0.0.1','fe80::1']) assert.equal(isPublicAddress(address), false);
  let requests = 0;
  const fetcher = async () => { requests++; return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }); };
  await assert.rejects(fetchSourceDocumentBytes(sourceUrl, { title: 'Equinor' }, { fetcher, resolver: async () => [{ address: '127.0.0.1' }] }), /intern/);
  assert.equal(requests, 0);
  await assert.rejects(fetchSourceDocumentBytes(sourceUrl, { title: 'Equinor' }, { fetcher, resolver: async () => [{ address: '93.184.216.34' }] }), /ikke verifisert/);
  assert.equal(requests, 1);
});

test('Oversized source documents stop before extraction', async () => {
  await assert.rejects(fetchSourceDocumentBytes(sourceUrl, { title: 'Equinor' }, {
    resolver: async () => [{ address: '93.184.216.34' }],
    fetcher: async () => new Response('not consumed', { headers: { 'content-type': 'text/html', 'content-length': '2000001' } }),
  }), /for stort/);
});

test('Tracking parameters do not create a new event URL', () => {
  assert.equal(canonicalSourceUrl(`${sourceUrl}?utm_source=feed#top`), sourceUrl);
  assert.deepEqual(ageReasons({ at: 'bad date', kind: 'publication_meta' }), ['original_date_unverified']);
});

test('Run queue stops after its quota and does not opportunistically research old work', () => {
  const rows = [1,2,3].map(id => ({ radar_item_id: id, state: 'review', article_status: 'draft' }));
  rows.push({ radar_item_id: 4, state: 'selected' });
  const queue = caseQueue(rows, 3);
  assert.equal(queue.draftsCreated, 3);
  assert.deepEqual(queue.researchIds, []);
});

test('Run queue separates active leases, deferred retries, exhausted retries and ready work', () => {
  const queue = caseQueue([
    { radar_item_id: 1, state: 'researching', lease_until: new Date(Date.now() + 60000) },
    { radar_item_id: 2, state: 'failed', step: 'write', attempts: { write: 1 }, retry_after: new Date(Date.now() + 60000) },
    { radar_item_id: 3, state: 'failed', step: 'research', attempts: { research: 3 } },
    { radar_item_id: 4, state: 'ready' },
  ]);
  assert.equal(queue.busy, 1); assert.equal(queue.deferredDrafting, 1); assert.equal(queue.failed, 1);
  assert.deepEqual(queue.draftIds, [4]);
});
