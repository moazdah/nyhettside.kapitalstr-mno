import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { database,application } from './helpers/runtime.mjs';
import { applyMigration } from '../lib/editorial/migrate.mjs';
import { engineChecks } from './engine-checks.mjs';
import { liveHealth,slot } from '../lib/engine/clock.mjs';

test('Durable jobs: deduplication, concurrent claims, restart, fencing, retry and exhaustion',async()=>{
  const d=await database();
  try {
    await d.pg.exec('CREATE TABLE editorial_settings(id int); CREATE TABLE feed(id bigint);');
    const migration=await readFile(new URL('../migrations/002_news_engine.sql',import.meta.url),'utf8');
    await applyMigration(d.sql,'002_news_engine.sql',migration);
    await applyMigration(d.sql,'002_news_engine.sql',migration);
    await engineChecks(d.sql);
  } finally { await d.pg.close(); }
});
test('Live health: actual success age, opening grace, disabled and closed hours',()=>{
  const now=new Date('2026-09-26T10:00:00Z');
  assert.equal(liveHealth({now,lastSuccess:'2026-09-26T09:44:00Z'}).status,'error');
  assert.equal(liveHealth({now,lastSuccess:'2026-09-26T09:44:00Z'}).delayMinutes,11);
  assert.equal(liveHealth({now,lastSuccess:'2026-09-26T09:49:00Z'}).status,'warning');
  assert.equal(liveHealth({now,enabled:false}).status,'paused');
  assert.equal(liveHealth({now:new Date('2026-09-26T02:00:00Z')}).status,'closed');
  assert.equal(liveHealth({now:new Date('2026-09-26T04:04:00Z')}).status,'ok');
  assert.equal(liveHealth({now:new Date('2026-09-26T04:15:00Z')}).status,'error');
  assert.notEqual(slot(new Date('2026-10-25T00:05:00Z')),slot(new Date('2026-10-25T01:05:00Z')));
});
test('Live publication switch remains independent from article review',async()=>{
  const d=await database();
  try {
    const app=application(d.sql);
    const settings=await app.load('lib/autopilot/editorial-settings.js');
    await settings.setAutoPublishEnabled(false,d.sql);
    assert.equal((await settings.getEditorialSettings(d.sql)).livePublishEnabled,true);
    await settings.setLivePublishEnabled(false,d.sql);
    assert.equal((await settings.getEditorialSettings(d.sql)).autoPublishEnabled,false);
    assert.equal((await settings.getEditorialSettings(d.sql)).articleReviewOnly,true);
  } finally {await d.pg.close();}
});

test('Live feed retries preserve timestamps and concurrent publication caps active items at twelve',async()=>{
  const d=await database();
  try {
    const {initialize}=await import('./helpers/runtime.mjs');
    const app=application(d.sql,{ai:async options=>({json:{items:JSON.parse(options.user).map(row=>({id:row.id,publish:true,headline:row.title,summary:'Verifisert kort melding'}))},usage:{}})});
    await initialize(d,app);
    await d.pg.exec(`CREATE TABLE feed(id bigserial primary key,tekst text,seksjon text,tidspunkt timestamptz DEFAULT now(),status text DEFAULT 'live');`);
    const live=await app.load('lib/live-updates.js');
    const schema=await app.load('lib/live-update-schema.js');
    await schema.ensureLiveUpdateSchema(d.sql);
    for(let i=0;i<11;i++) await d.sql`INSERT INTO feed(tekst,tidspunkt) VALUES('Existing',now()-interval '1 minute')`;
    for(let i=0;i<4;i++) await d.sql`INSERT INTO radar_items(external_id,title,summary,url,source_name,source_kind,published_at,ai_scored_at,ai_score,local_triage_status,next_step,event_key)
      VALUES(${`live-${i}`},${`Equinor kontrakt ${i}`},'Nytt fra Equinor','https://www.equinor.com/news/test','Equinor','official',now()-interval '10 minutes',now(),85,'candidate','overvak',${`event-${i}`})`;
    await Promise.all([live.syncLiveUpdatesFromRecentRadar(),live.syncLiveUpdatesFromRecentRadar()]);
    const rows=await d.sql`SELECT * FROM feed WHERE radar_item_id IS NOT NULL ORDER BY id`;
    assert.equal(rows.length,4);
    assert.ok(rows.every(row=>row.source_published_at && new Date(row.source_published_at)<new Date(row.tidspunkt)));
    const [count]=await d.sql`SELECT count(*)::int AS n FROM feed WHERE status='live'`;
    assert.equal(count.n,12);
    await live.syncLiveUpdatesFromRecentRadar();
    const repeated=await d.sql`SELECT * FROM feed WHERE radar_item_id IS NOT NULL ORDER BY id`;
    assert.deepEqual(repeated.map(row=>String(row.tidspunkt)),rows.map(row=>String(row.tidspunkt)));
  } finally {await d.pg.close();}
});
