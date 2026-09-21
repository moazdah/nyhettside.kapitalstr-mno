import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { applyMigration } from '../lib/editorial/migrate.mjs';
import { registerCase, claimCase, finishCase, getCase } from '../lib/editorial/store.mjs';
import { assessAudience } from '../lib/editorial/contract.mjs';
import { sourceRoleFromUrl } from '../lib/editorial/source-policy.mjs';
import { application } from './editorial-runtime.mjs';
let stage = 'configuration';
const log = data => console.log(JSON.stringify(data));
function safeMessage(error) {
  let text=String(error?.message || error || '');
  for (const value of Object.values(process.env).filter(v=>v && v.length>12)) text=text.replaceAll(value,'[REDACTED]');
  return text.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s'"<>]+/gi,'[URL]').replace(/sk-[\w-]+/g,'[KEY]').slice(0,350);
}
function directConnection(value) {
  if (!value) return value;
  const url = new URL(value);
  assert.ok(url.hostname.endsWith('.neon.tech'), 'EXPECTED_NEON_ENDPOINT');
  // Neon uses the same branch credentials for direct and pooled endpoints.
  url.hostname = url.hostname.replace('-pooler.', '.');
  return url.toString();
}
function fingerprint(connection) {
  const url = new URL(connection);
  assert.equal(url.hostname.includes('-pooler.'), false, 'DIRECT_CONNECTION_REQUIRED');
  return createHash('sha256').update(url.hostname).digest('hex').slice(0,16);
}
try {
  const testUrl = directConnection(process.env.EDITORIAL_TEST_DATABASE_URL_UNPOOLED);
  const prodUrl = directConnection(process.env.EDITORIAL_PRODUCTION_DATABASE_URL_UNPOOLED);
  log({stage, testConfigured:Boolean(testUrl), productionConfigured:Boolean(prodUrl), deepseekConfigured:Boolean(process.env.DEEPSEEK_API_KEY),
    testPooled:testUrl ? new URL(testUrl).hostname.includes('-pooler.') : null,
    productionPooled:prodUrl ? new URL(prodUrl).hostname.includes('-pooler.') : null});
  assert.ok(testUrl && prodUrl && process.env.DEEPSEEK_API_KEY, 'REQUIRED_SECRET_MISSING');
  assert.equal(fingerprint(testUrl), '1c0147c77e07b78e', 'UNEXPECTED_TEST_ENDPOINT');
  assert.notEqual(fingerprint(testUrl), fingerprint(prodUrl), 'TEST_POINTS_TO_PRODUCTION');
  const sql = neon(testUrl), other = neon(testUrl), production = neon(prodUrl);
  const baseline = await production.transaction([
    production`SELECT count(*)::int AS articles FROM articles`,
    production`SELECT automation_enabled, auto_publish_enabled FROM editorial_settings WHERE id=1`,
  ], { readOnly: true });
  log({stage, separateDatabases:true, productionReadable:true, production:baseline});
  process.env.EDITORIAL_AUTOPUBLISH_V1 = 'false';
  const app = application(sql);
  stage = 'test_migration';
  const contents = await readFile(new URL('../migrations/001_editorial_cases.sql', import.meta.url), 'utf8');
  await Promise.all([applyMigration(sql,'001_editorial_cases.sql',contents), applyMigration(other,'001_editorial_cases.sql',contents)]);
  const [ledger] = await sql`SELECT count(*)::int AS n FROM kapitalstrom_migrations WHERE name='001_editorial_cases.sql'`;
  assert.equal(ledger.n,1);
  log({stage,ok:true,concurrentMigrationIdempotent:true});
  stage = 'concurrent_workers';
  const [radar] = await sql`INSERT INTO radar_items(external_id,title,summary,url,source_name,source_domain,ai_score,ai_section,candidate_type)
    VALUES(${`validation-${randomUUID()}`},'Equinor kontrakt test','Isolert teknisk låsetest','https://www.equinor.com/news/validation','Equinor','equinor.com',85,'Selskaper','kontrakt') RETURNING *`;
  try {
    const c = await registerCase(sql,radar);
    const claims = await Promise.allSettled([claimCase(sql,c,'research'),claimCase(other,c,'research')]);
    assert.equal(claims.filter(x=>x.status==='fulfilled').length,1);
    const winner = claims.find(x=>x.status==='fulfilled').value;
    await sql`UPDATE editorial_cases SET lease_until=now()-interval '1 second' WHERE id=${c.id}`;
    const replacement = await claimCase(other,c,'research');
    await assert.rejects(finishCase(sql,winner,[],{state:'ready',dossier:winner.dossier}),/EDITORIAL_LEASE_LOST/);
    await finishCase(other,replacement,[],{state:'blocked',dossier:replacement.dossier});
    assert.equal((await getCase(sql,radar.id)).state,'blocked');
    log({stage,ok:true,singleWinner:true,staleWorkerRejected:true});
  } finally {
    await sql.transaction([
      sql`DELETE FROM editorial_case_events WHERE case_id IN (SELECT id FROM editorial_cases WHERE radar_item_id=${radar.id})`,
      sql`DELETE FROM editorial_cases WHERE radar_item_id=${radar.id}`,
      sql`DELETE FROM radar_items WHERE id=${radar.id}`,
    ]);
  }
  stage='deepseek_connection';
  const client=await app.load('lib/ai/deepseek-client.js');
  const response=await client.deepSeekJsonRequest({model:'deepseek-v4-pro',system:'Return JSON only.',user:'Return {"ok":true}.',maxTokens:100,timeoutMs:30000,retries:0});
  assert.equal(response.json.ok,true);
  log({stage,ok:true,usage:response.usage});
  stage='real_research';
  const writer=await app.load('lib/ai/write-article.js');
  await writer.ensureArticleWriterSchema(sql);
  const research=await app.load('lib/research/fact-pack.js');
  const candidates=await sql`SELECT * FROM radar_items WHERE url IS NOT NULL ORDER BY published_at DESC NULLS LAST,discovered_at DESC LIMIT 100`;
  const selected=candidates.filter(x=>assessAudience(x).eligible && sourceRoleFromUrl(x.primary_source_url||x.url,x).role!=='unknown').slice(0,8);
  let drafts=0, rejected=0, errors=0;
  for (const candidate of selected) {
    const existing=await getCase(sql,candidate.id);
    if(existing?.state==='failed') log({stage:'previous_failure',radarId:candidate.id,step:existing.step,error:safeMessage(existing.last_error)});
    if(existing?.retry_after && new Date(existing.retry_after)>new Date()) {
      log({stage:'retry_wait',radarId:candidate.id}); continue;
    }
    try {
    const result=await research.buildFactPackForRadarItem(candidate.id, { manualOverride: existing?.state === 'failed' && existing?.step === 'research' });
    log({stage,radarId:candidate.id,title:candidate.title,...result});
    if(result.canWrite && drafts<2) {
      stage='real_draft';
      const draft=await writer.generateArticleDraftFromRadar(candidate.id);
      const [row]=await sql`SELECT status,tall_validert FROM articles WHERE id=${draft.articleId}`;
      assert.equal(row.status,'draft');
      log({stage,...draft,storedStatus:row.status});
      drafts++;
      stage='real_research';
    } else rejected++;
    } catch(error) {
      errors++;
      log({stage,radarId:candidate.id,error:safeMessage(error)});
      stage='real_research';
    }
  }
  log({stage:'complete',ok:errors===0,candidates:selected.length,drafts,rejected,errors,autopublish:false,
    limitation:drafts?'Real drafts require editorial review.':'No eligible document yielded a draft; full real-source flow remains unverified.'});
  if(errors) process.exitCode=1;
} catch(error) {
  // Never emit arbitrary provider exceptions, which may contain credentials.
  const safeCode=/^[A-Z0-9_]{1,64}$/.test(String(error.code||''))?error.code:'VALIDATION_FAILED';
  const reason = safeMessage(error);
  log({ok:false,stage,code:safeCode,kind:error.name,reason});
  process.exitCode=1;
}
