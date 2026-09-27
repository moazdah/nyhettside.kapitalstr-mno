import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { database,application } from './helpers/runtime.mjs';
import { parseDecision,decisionLinks,isDecisionUrl,plain } from '../lib/breaking/norges-bank.mjs';
import { publishFlash } from '../lib/breaking/store.mjs';
import { claim } from '../lib/engine/jobs.mjs';
const url='https://www.norges-bank.no/aktuelt/nyheter/Pressemeldinger/2026/2026-09-24-rente/';
const publishedAt='2026-09-24T08:00:00Z',now=Date.parse(publishedAt)+3000;
const source='På møtet besluttet komiteen å sette styringsrenten opp fra 4,25 til 4,50 prosent. Prisveksten er fortsatt for høy. Komiteen vurderer at en høyere rente er nødvendig for å få prisveksten ned.';
const html=`<meta property="article:published_time" content="${publishedAt}"><h1 class="visually-hidden">Norges Bank</h1><h1>Styringsrenten settes opp til 4,50 prosent</h1><p>${source}</p>`;
const decision=()=>parseDecision(html,{url,publishedAt,now});
test('Official source HTML entities are decoded before literal evidence comparison',()=>{
 assert.equal(plain('P&aring; m&oslash;tet kom komit&eacute;en &ndash; &aelig;rlig &#229; &#xF8;.'),'På møtet kom komitéen – ærlig å ø.');
 const encoded=html.replaceAll('å','&aring;').replaceAll('ø','&oslash;');
 assert.equal(parseDecision(encoded,{url,publishedAt,now}).text,decision().text);
});
async function setup(options={}) {
 const d=await database(),app=application(d.sql,options);
 const settings=await app.load('lib/autopilot/editorial-settings.js');await settings.getEditorialSettings(d.sql);
 await d.pg.exec("CREATE TABLE feed(id bigserial primary key,tekst text,seksjon text,status text,tidspunkt timestamptz DEFAULT now());");
 await (await app.load('lib/live-update-schema.js')).ensureLiveUpdateSchema(d.sql);
 for(const file of ['002_news_engine.sql','003_breaking_desk.sql']) await d.pg.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 await d.sql`UPDATE editorial_settings SET breaking_publish_enabled=true WHERE id=1`;
 return {...d,app};
}
test('Official decision: verifies host, date, freshness, direction and publication time',()=>{
 assert.equal(decision().rate,4.5);
 assert.equal(decision().previous,4.25);
 assert.equal(isDecisionUrl(url.replace('www.norges-bank.no','www.norges-bank.no.evil.test')),false);
 assert.equal(decisionLinks(`<rss><item><link>${url}</link><pubDate>${publishedAt}</pubDate></item></rss>`,now).length,1);
 assert.equal(decisionLinks(`<rss><item><link>${url}</link><pubDate>${publishedAt}</pubDate></item></rss>`,now+86400000).length,0);
 assert.throws(()=>parseDecision(html,{url,publishedAt,now:now+86400000}),/NOT_FRESH/);
 assert.throws(()=>parseDecision(html,{url,publishedAt,now:now-120000}),/NOT_FRESH/);
 assert.throws(()=>parseDecision(html.replace('opp fra 4,25 til 4,50','opp fra 4,25 til 4,75'),{url,publishedAt,now}),/CONFLICT/);
 assert.throws(()=>parseDecision(html,{url,publishedAt:'2026-09-24T09:00:00Z',now}),/TIME_CONFLICT/);
 assert.throws(()=>parseDecision(html,{url:url.replace('24-rente','23-rente'),publishedAt,now}),/DATE_CONFLICT/);
});
test('Flash publication is atomic, repeatable, capped at twelve, and respects automation switches',async()=>{
 const d=await setup();
 try {
  for(let i=0;i<12;i++) await d.sql`INSERT INTO feed(tekst,status,tidspunkt) VALUES('Earlier','live',now()-interval '1 minute')`;
  const a=await publishFlash(d.sql,decision()),b=await publishFlash(d.sql,decision());
  assert.equal(a.article_id,b.article_id);assert.equal(String(a.first_published_at),String(b.first_published_at));
  const [counts]=await d.sql`SELECT (SELECT count(*) FROM articles)::int AS articles,(SELECT count(*) FROM engine_jobs)::int AS jobs,(SELECT count(*) FROM feed WHERE status='live')::int AS feed`;
  assert.deepEqual(counts,{articles:1,jobs:1,feed:12});
  await d.sql`UPDATE editorial_settings SET auto_publish_enabled=false WHERE id=1`;
  await assert.rejects(publishFlash(d.sql,{...decision(),url:url.replace('24-rente','25-rente')}),/DISABLED/);
  assert.equal((await d.sql`SELECT * FROM breaking_events`).length,1);
 } finally {await d.pg.close();}
});
test('Failed enrichment keeps the flash live; retry updates the same article without changing publication time',async()=>{
 let calls=0;
 const paragraphs=[decision().fact,'Norges Bank opplyser at prisveksten fortsatt er for høy.','Komiteen vurderer at en høyere rente er nødvendig for å få prisveksten ned.'];
 const d=await setup({ai:async()=>{
  calls++;
  if(calls===1) throw new Error('provider unavailable');
  if(calls===2) return {json:{paragraphs,summary:paragraphs}};
  return {json:{passed:true,checks:Array.from({length:6},(_,id)=>({id,supported:true,source_ids:['S1']}))}};
 }});
 try {
  const first=await publishFlash(d.sql,decision());
  const worker=await d.app.load('lib/breaking/enrich.js');
  await assert.rejects(worker.enrichNext(d.sql),/provider unavailable/);
  const [flash]=await d.sql`SELECT * FROM articles`;assert.equal(flash.status,'live');
  assert.match(flash.brodtekst,/Saken oppdateres/);
  await d.sql`UPDATE engine_jobs SET retry_after=now()-interval '1 second'`;
  assert.equal((await worker.enrichNext(d.sql)).enriched,true);
  const [article]=await d.sql`SELECT * FROM articles`;
  assert.equal(article.id,first.article_id);assert.equal(String(article.publisert_at),String(first.first_published_at));
  assert.equal(article.summary_points.length,3);assert.doesNotMatch(article.brodtekst,/Saken oppdateres/);
  assert.equal((await d.sql`SELECT * FROM breaking_revisions`).length,2);
  assert.equal((await worker.enrichNext(d.sql)).skipped,true);
 } finally {await d.pg.close();}
});
test('Unsupported generated numbers cannot replace the verified flash',async()=>{
 const d=await setup({ai:async options=>options.label.includes('kontroll')?{json:{passed:true,checks:Array.from({length:6},(_,id)=>({id,supported:true,source_ids:['S1']}))}}:{json:{paragraphs:['Norges Bank hever styringsrenten til 7,50 prosent.','Norges Bank opplyser at prisveksten fortsatt er for høy.','Komiteen vurderer at en høyere rente er nødvendig.'],summary:Array(3).fill('Norges Bank opplyser at prisveksten er for høy.')}}});
 try {
  await publishFlash(d.sql,decision());const worker=await d.app.load('lib/breaking/enrich.js');
  await assert.rejects(worker.enrichNext(d.sql),/NUMBER_NOT_IN_SOURCE/);
  const [article]=await d.sql`SELECT * FROM articles`;assert.doesNotMatch(article.brodtekst,/7,50/);
 } finally {await d.pg.close();}
});

test('Official parser accepts unchanged and cut decisions with integer rates',()=>{
 const unchanged=`<h1>Styringsrenten holdes uendret på 4 prosent</h1><p>Komiteen besluttet å holde styringsrenten uendret på 4 prosent.</p>`;
 assert.equal(parseDecision(unchanged,{url,publishedAt,now}).direction,'unchanged');
 const cut=`<h1>Styringsrenten settes ned til 4 prosent</h1><p>Komiteen besluttet å sette styringsrenten ned fra 4,25 til 4 prosent.</p>`;
 assert.equal(parseDecision(cut,{url,publishedAt,now}).direction,'down');
});

test('Pausing the live rail does not prevent an independently enabled breaking article',async()=>{
 const d=await setup();
 try {
  await d.sql`UPDATE editorial_settings SET live_publish_enabled=false WHERE id=1`;
  const flash=await publishFlash(d.sql,decision());
  assert.ok(flash.article_id);
  assert.equal((await d.sql`SELECT * FROM feed WHERE status='live'`).length,0);
 } finally {await d.pg.close();}
});

test('A model cannot invent evidence identifiers to approve an enrichment',async()=>{
 const d=await setup({ai:async options=>options.label.includes('kontroll')?
  {json:{passed:true,checks:Array.from({length:6},(_,id)=>({id,supported:true,source_ids:['S999999']}))}}:
  {json:{paragraphs:Array(3).fill(decision().fact),summary:Array(3).fill(decision().fact)}}});
 try {
  await publishFlash(d.sql,decision());const worker=await d.app.load('lib/breaking/enrich.js');
  await assert.rejects(worker.enrichNext(d.sql),/ENRICHMENT_EVIDENCE_MISSING/);
  assert.equal((await d.sql`SELECT * FROM breaking_revisions`).length,1);
 } finally {await d.pg.close();}
});
