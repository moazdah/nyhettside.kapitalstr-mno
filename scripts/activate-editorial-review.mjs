import assert from 'node:assert/strict';
import { neon } from '@neondatabase/serverless';
const base='https://nyhettside-kapitalstr-mno-ashy.vercel.app';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let stage='verify_production_commit';
try {
  assert.match(process.env.GITHUB_SHA||'',/^[a-f0-9]{40}$/);
  assert.ok(process.env.CRON_SECRET,'CRON_SECRET_MISSING');
  assert.ok(process.env.EDITORIAL_PRODUCTION_DATABASE_URL_UNPOOLED,'DATABASE_SECRET_MISSING');
  let ready=false;
  for(let attempt=0;attempt<30;attempt++) {
    try {
      const response=await fetch(`${base}/api/health`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
      const health=await response.json();
      ready=response.ok && health.version===process.env.GITHUB_SHA && health.editorial?.schema_ready
        && health.editorial?.publication_guard_ready && health.editorial?.mode==='review';
      if(ready) break;
    } catch { /* Next attempt; keep automation disabled until the exact build responds. */ }
    console.log(JSON.stringify({stage,attempt:attempt+1,ready:false}));
    await pause(20000);
  }
  assert.ok(ready,'PRODUCTION_NOT_READY');
  stage='activate_review';
  const url=new URL(process.env.EDITORIAL_PRODUCTION_DATABASE_URL_UNPOOLED);
  assert.ok(url.hostname.endsWith('.neon.tech'));
  url.hostname=url.hostname.replace('-pooler.','.');
  const sql=neon(url.toString());
  await sql`UPDATE editorial_settings SET automation_enabled=true,auto_publish_enabled=false,updated_at=now() WHERE id=1`;
  console.log(JSON.stringify({stage,ok:true,commit:process.env.GITHUB_SHA,automation:true,autopublish:false}));
  stage='first_scheduled_round';
  assert.ok(process.env.CRON_SECRET,'CRON_SECRET_MISSING');
  let runId=null;
  for(let step=0;step<45;step++) {
    const path=runId?`?runId=${runId}`:'?discovery=1';
    const response=await fetch(`${base}/api/cron/editorial-autopilot${path}`,{
      headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(285000)});
    assert.ok(response.ok,'EDITORIAL_ENDPOINT_FAILED');
    const result=await response.json();
    assert.equal(result.ok,true,'EDITORIAL_STEP_FAILED');
    runId=result.runId||runId;
    console.log(JSON.stringify({stage,step:step+1,runId,editorialStage:result.stage,processed:result.processed,
      errors:result.errors?.length||0,skipped:result.skipped||false,reason:result.reason}));
    if(result.stage==='done'||result.skipped) {
      console.log(JSON.stringify({stage:'complete',ok:true,runId,drafts:result.state?.draftsCreated||0,autopublish:false}));
      break;
    }
    assert.ok(runId,'RUN_ID_MISSING');
    if(step===44) throw new Error('ROUND_NOT_FINISHED');
    await pause(Math.max(2,Math.min(30,Number(result.state?.retryAfterSeconds)||2))*1000);
  }
} catch(error) {
  console.error(JSON.stringify({ok:false,stage,reason:/^[A-Z_]+$/.test(error.message)?error.message:'ACTIVATION_FAILED'}));
  process.exitCode=1;
}
