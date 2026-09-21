import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { database, application, initialize } from './helpers/runtime.mjs';
import { fixture } from './helpers/fixtures.mjs';
import { registerCase, claimCase, finishCase, failCase, getCase, requireEditorialSchema } from '../lib/editorial/store.mjs';
import { publishCaseArticle } from '../lib/editorial/publish.mjs';
import { articleSnapshot } from '../lib/editorial/contract.mjs';
import { schemaOnce } from '../lib/editorial/schema-once.mjs';

let db, app, writer, selection;
before(async () => {
  db = await database(); app = application(db.sql);
  ({ writer, selection } = await initialize(db, app));
});
after(async () => { await db?.pg.close(); });

let counter = 0;
async function seeded({ reviewed = false } = {}) {
  const f = fixture(); const { sql } = db;
  const [run] = await sql`INSERT INTO editorial_runs (discovery_done, triage_done, selection_done) VALUES (true,true,true) RETURNING *`;
  const key = `event-${++counter}`;
  const [item] = await sql`INSERT INTO radar_items (external_id,title,summary,source_name,url,local_event_key,autopilot_run_id)
    VALUES (${key},${f.item.title},${f.item.summary},'Equinor',${f.item.url},${key},${run.id}) RETURNING *`;
  const editorialCase = await registerCase(sql, item, run.id);
  if (!reviewed) return { ...f, item, run, editorialCase };
  const p = f.snapshot;
  const [pack] = await sql`INSERT INTO fact_packs (radar_item_id,status,version,primary_source_name,primary_source_url,
    source_role,source_quality,source_hash,headline_fact,event_type,facts,numbers,entities,unknowns,
    market_relevance,analysis_signals,can_write,confidence)
    VALUES (${item.id},'ready',${p.version},${p.primary_source_name},${p.primary_source_url},${p.source_role},${p.source_quality},
      ${p.source_hash},${p.headline_fact},${p.event_type},${JSON.stringify(p.facts)}::jsonb,${JSON.stringify(p.numbers)}::jsonb,
      ${JSON.stringify(p.entities)}::jsonb,${JSON.stringify(p.unknowns)}::jsonb,${p.market_relevance},
      ${JSON.stringify(p.analysis_signals)}::jsonb,${p.can_write},${p.confidence}) RETURNING *`;
  const a = f.article;
  const [article] = await sql`INSERT INTO articles (slug,tittel,undertittel,brodtekst,seksjon,tall_validert,radar_item_id,fact_pack_id)
    VALUES (${key},${a.tittel},${a.undertittel},${a.brodtekst},${a.seksjon},true,${item.id},${pack.id}) RETURNING *`;
  const dossier = { ...f.dossier, identity: { radarId: Number(item.id), eventKey: key } };
  await sql`UPDATE editorial_cases SET state='review',dossier=${JSON.stringify(dossier)}::jsonb,
    article_id=${article.id},fact_pack_id=${pack.id} WHERE id=${editorialCase.id}`;
  return { ...f, item, run, article, pack, dossier, editorialCase: await getCase(sql,item.id) };
}

test('Legacy schema initialization is shared and warm calls perform no DDL', async () => {
  const before = db.queries.length;
  await Promise.all([writer.ensureArticleWriterSchema(db.sql), writer.ensureArticleWriterSchema(db.sql), selection.ensureEditorialSelectionSchema(db.sql)]);
  assert.equal(db.queries.length, before);
  let attempts = 0;
  const key = () => {};
  await assert.rejects(schemaOnce(key,'retry',async () => { attempts++; throw new Error('network interruption'); }));
  await Promise.all([schemaOnce(key,'retry',async () => { attempts++; }), schemaOnce(key,'retry',async () => { attempts++; })]);
  assert.equal(attempts, 2);
});

test('Case readiness is read-only and fails clearly if the migration is missing', async () => {
  const queries = [];
  const sql = (parts) => { queries.push(parts.join('')); return Promise.resolve([{ cases: null, guard: null }]); };
  await assert.rejects(requireEditorialSchema(sql), error => error.code === 'MIGRATION_REQUIRED');
  assert.ok(queries.every(query => !/ALTER|CREATE/.test(query)));
});

test('Registering the same event is idempotent; another radar item cannot own it', async () => {
  const f = await seeded();
  const again = await registerCase(db.sql,f.item,f.run.id);
  assert.equal(again.id, f.editorialCase.id);
  assert.equal((await registerCase(db.sql,{...f.item,local_event_key:'later-cluster-key'},f.run.id)).id,f.editorialCase.id);
  const [other] = await db.sql`INSERT INTO radar_items(external_id,title,source_name,url)
    VALUES('same-event-second-source','Equinor kontrakt','E24','https://e24.no/article') RETURNING *`;
  await assert.rejects(registerCase(db.sql,{ ...other, event_key: f.item.local_event_key },f.run.id), error => error.code === 'EVENT_ALREADY_ASSIGNED');
});

test('Noise cleanup preserves a case and its evidence without stopping discovery', async () => {
  const f=await seeded();
  await db.sql`UPDATE radar_items SET title='Fotball restaurant ferie',summary='Fotball og ferie' WHERE id=${f.item.id}`;
  const radar=await app.load('lib/radar/news-radar.js');
  await radar.pruneRadarNoise(db.sql);
  assert.ok(await getCase(db.sql,f.item.id));
});

test('Overlapping workers cannot both acquire a case', async () => {
  const f = await seeded();
  const results = await Promise.allSettled([claimCase(db.sql,f.editorialCase,'research'),claimCase(db.sql,f.editorialCase,'research')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected')[0].reason.code, 'CASE_NOT_CLAIMABLE');
});

test('A late worker cannot commit after its expired lease has been reclaimed', async () => {
  const f = await seeded(); const { sql } = db;
  const stale = await claimCase(sql,f.editorialCase,'research');
  await sql`UPDATE editorial_cases SET lease_until=now()-interval '1 second' WHERE id=${stale.id}`;
  const current = await claimCase(sql,f.editorialCase,'research');
  await assert.rejects(finishCase(sql,stale,[sql`UPDATE radar_items SET summary='STALE WRITE' WHERE id=${f.item.id}`],
    { state:'ready',dossier:stale.dossier }), /EDITORIAL_LEASE_LOST/);
  const [item] = await sql`SELECT summary FROM radar_items WHERE id=${f.item.id}`;
  assert.equal(item.summary,f.item.summary);
  await failCase(sql,stale,new Error('late error'));
  assert.equal((await getCase(sql,f.item.id)).lease_token,current.token);
});

test('A failed transaction rolls back evidence, state and journal together', async () => {
  const f = await seeded(); const { sql } = db;
  const claim = await claimCase(sql,f.editorialCase,'research');
  await assert.rejects(finishCase(sql,claim,[
    sql`UPDATE radar_items SET summary='PARTIAL WRITE' WHERE id=${f.item.id}`,
    sql`SELECT 1/0`,
  ],{state:'ready',dossier:claim.dossier}), /division by zero/);
  assert.equal((await sql`SELECT summary FROM radar_items WHERE id=${f.item.id}`)[0].summary,f.item.summary);
  assert.equal((await getCase(sql,f.item.id)).state,'researching');
  assert.equal((await sql`SELECT count(*)::int AS n FROM editorial_case_events WHERE case_id=${claim.id}`)[0].n,0);
});

test('A lost response after commit cannot turn success into failed work', async () => {
  const f = await seeded(); const { sql } = db;
  const claim = await claimCase(sql,f.editorialCase,'research');
  await finishCase(sql,claim,[],{state:'blocked',dossier:claim.dossier});
  await failCase(sql,claim,new Error('response lost'));
  assert.equal((await getCase(sql,f.item.id)).state,'blocked');
});

test('Retry budget is bounded and manual override cannot steal an active lease', async () => {
  const f = await seeded(); const { sql } = db;
  for (let i=0;i<3;i++) {
    const claim = await claimCase(sql,f.editorialCase,'research');
    await assert.rejects(claimCase(sql,f.editorialCase,'research',{force:true}), error => error.code === 'CASE_NOT_CLAIMABLE');
    await failCase(sql,claim,new Error('provider down'));
    await sql`UPDATE editorial_cases SET retry_after=now()-interval '1 second' WHERE id=${claim.id}`;
  }
  await assert.rejects(claimCase(sql,f.editorialCase,'research'),error=>error.code==='CASE_NOT_CLAIMABLE');
  // An explicit rebuild can repair a later failed step as well. It still
  // cannot steal an active lease, as asserted above, or replace a live story.
  await sql`UPDATE editorial_cases SET step='verify' WHERE id=${f.editorialCase.id}`;
  assert.equal((await claimCase(sql,f.editorialCase,'research',{force:true})).claimedStep,'research');
});

test('Automatic publishing defaults to review; manual review can publish exactly once', async () => {
  const f = await seeded({reviewed:true});
  assert.equal((await publishCaseArticle(db.sql,f.article.id,{runId:f.run.id})).reason,'editorial_review_mode');
  assert.equal((await publishCaseArticle(db.sql,f.article.id,{manual:true})).published,true);
  assert.equal((await publishCaseArticle(db.sql,f.article.id,{manual:true})).reason,'already_live');
  assert.equal((await getCase(db.sql,f.item.id)).state,'published');
  const rows=await db.sql`SELECT * FROM editorial_case_events WHERE case_id=${f.editorialCase.id} AND status='published'`;
  assert.equal(rows.length,1);
});

test('Automatic publishing cannot consume another round’s article', async () => {
  const f = await seeded({reviewed:true});
  const result = await publishCaseArticle(db.sql,f.article.id,{runId:Number(f.run.id)+1,autoPublishEnabled:true});
  assert.equal(result.reason,'run_mismatch');
});

test('Manual edits and fact-pack changes both invalidate publication', async () => {
  const f = await seeded({reviewed:true}); const { sql }=db;
  await sql`UPDATE articles SET tittel='Changed after review' WHERE id=${f.article.id}`;
  assert.ok((await publishCaseArticle(sql,f.article.id,{manual:true})).reasons.includes('draft_changed'));
  const other=await seeded({reviewed:true});
  await sql`UPDATE fact_packs SET confidence=99 WHERE id=${other.pack.id}`;
  assert.ok((await publishCaseArticle(sql,other.article.id,{manual:true})).reasons.includes('fact_pack_changed'));
});

test('Database publication guard rejects a race after the application checks passed', async () => {
  const f = await seeded({reviewed:true}); const { sql }=db;
  const claim=await claimCase(sql,f.editorialCase,'publish');
  await sql`UPDATE articles SET brodtekst='Edited during publication' WHERE id=${f.article.id}`;
  await assert.rejects(finishCase(sql,claim,[
    sql`SELECT editorial_assert_publication(${claim.id},${claim.token}::uuid,${JSON.stringify(articleSnapshot(f.article))}::jsonb,${JSON.stringify(f.snapshot)}::jsonb)`,
    sql`UPDATE articles SET status='live' WHERE id=${f.article.id}`,
  ],{state:'published',dossier:claim.dossier,articleId:f.article.id}),/EDITORIAL_DRAFT_CHANGED/);
  assert.equal((await sql`SELECT status FROM articles WHERE id=${f.article.id}`)[0].status,'draft');
});

test('Verification cannot attach an old verdict to text edited during its AI call', async () => {
  const f=await seeded({reviewed:true}); const { sql }=db;
  await sql`UPDATE articles SET brodtekst='A second edit',tall_validert=false WHERE id=${f.article.id}`;
  const claim=await claimCase(sql,f.editorialCase,'verify');
  await assert.rejects(finishCase(sql,claim,[
    sql`SELECT editorial_assert_draft(${f.article.id},${JSON.stringify(articleSnapshot(f.article))}::jsonb)`,
    sql`UPDATE articles SET tall_validert=true WHERE id=${f.article.id}`,
  ],{state:'review',dossier:claim.dossier}),/EDITORIAL_DRAFT_CHANGED/);
  assert.equal((await sql`SELECT tall_validert FROM articles WHERE id=${f.article.id}`)[0].tall_validert,false);
});

test('Round status uses the scoring cutoff and closes without processing another round', async () => {
  const {sql}=db;
  const autopilot=await app.load('lib/autopilot/autopilot.js');
  const [run]=await sql`INSERT INTO editorial_runs(discovery_done,triage_done,selection_done,notes)
    VALUES(true,true,false,jsonb_build_object('scoring_cutoff',now()-interval '1 hour')) RETURNING id`;
  await sql`INSERT INTO radar_items(external_id,title,url,source_name,local_triage_status,discovered_at)
    VALUES('later-live-discovery','Equinor kontrakt','https://equinor.com/news/later','Equinor','candidate',now())`;
  assert.equal((await autopilot.getAutopilotState(sql,run.id)).scoring,0);
  await sql`UPDATE editorial_runs SET selection_done=true WHERE id=${run.id}`;
  const result=await autopilot.runAutopilotStep({runId:run.id});
  assert.equal(result.stage,'done');
  assert.equal((await sql`SELECT status FROM editorial_runs WHERE id=${run.id}`)[0].status,'done');
});
