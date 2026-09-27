import assert from 'node:assert/strict';
import {neon} from '@neondatabase/serverless';
const base='https://nyhettside-kapitalstr-mno-ashy.vercel.app';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
 assert.match(process.env.GITHUB_SHA||'',/^[a-f0-9]{40}$/);
 assert.ok(process.env.CRON_SECRET,'CRON_SECRET_MISSING');
 let ready=false;
 for(let attempt=0;attempt<30;attempt++) {
  try {
   const r=await fetch(base+'/api/health',{cache:'no-store',signal:AbortSignal.timeout(15000)}),h=await r.json();
   ready=r.ok&&h.version===process.env.GITHUB_SHA&&h.editorial?.publication_guard_ready&&typeof h.breaking?.enabled==='boolean';
   if(ready) break;
  } catch {}
  console.log(JSON.stringify({stage:'await_deployment',attempt:attempt+1}));await pause(20000);
 }
 assert.ok(ready,'EXACT_PRODUCTION_BUILD_NOT_READY');
 const url=new URL(process.env.EDITORIAL_PRODUCTION_DATABASE_URL_UNPOOLED);assert.ok(url.hostname.endsWith('.neon.tech'));
 const sql=neon(url.toString());
 await sql`UPDATE editorial_settings SET automation_enabled=true,auto_publish_enabled=true,live_publish_enabled=true,breaking_publish_enabled=true,updated_at=now() WHERE id=1`;
 const health=await (await fetch(base+'/api/health',{cache:'no-store'})).json();
 assert.equal(health.editorial.mode,'automatic');assert.equal(health.breaking.enabled,true);
 for(const path of ['/api/cron/breaking','/api/cron/breaking-enrich']) {
  const r=await fetch(base+path,{headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(175000)});
  const result=await r.json();assert.ok(r.ok&&result.ok,'PRODUCTION_WATCH_FAILED');
  console.log(JSON.stringify({path,result}));
 }
 console.log(JSON.stringify({ok:true,commit:process.env.GITHUB_SHA,automaticArticles:true,automaticBreaking:true,automaticLive:true}));
} catch(error) {console.error(JSON.stringify({ok:false,reason:/^[A-Z_]+$/.test(error.message)?error.message:error.name}));process.exitCode=1;}
