import test from 'node:test';
import assert from 'node:assert/strict';
import { database, application, initialize } from './helpers/runtime.mjs';
import { fixture, sourceText, sourceUrl } from './helpers/fixtures.mjs';
import { getCase } from '../lib/editorial/store.mjs';
import { publishCaseArticle } from '../lib/editorial/publish.mjs';

// Real application and SQL, scripted external responses. This verifies the
// integration contract, NOT real DeepSeek accuracy or real provider availability.
for (const mode of ['success','missing-date','review-rejects','research-declines','verifier-unavailable-once']) {
  test(`Full research → draft → review flow: ${mode}`, async () => {
    const db=await database();
    try {
      const f=fixture(); const calls=[];
      const ai=async request=>{
        calls.push(request);
        assert.equal(request.retries,0);
        if(request.label==='DeepSeek faktapakke') return { json:{
          headline_fact:f.pack.headlineFact,event_type:'contract',matches_event:true,headline_fact_ids:['F1'],
          facts:f.pack.facts,numbers:f.pack.numbers,entities:['Equinor'],unknowns:[],market_relevance:'Norsk børsnotert selskap.',
          analysis_signals:{},can_write:mode!=='research-declines',confidence:90,
        },usage:{prompt_tokens:100,completion_tokens:50} };
        if(request.label==='DeepSeek V4 Pro artikkelmotor') return { json:{...f.draft,ai_analysis:'',quality_score:40},usage:{prompt_tokens:100,completion_tokens:50} };
        if(request.label==='DeepSeek uavhengig kontroll av utkast') {
          if(mode==='verifier-unavailable-once' && calls.filter(c=>c.label===request.label).length===1) throw new Error('Verifier temporarily unavailable');
          const response=structuredClone(f.response);
          if(mode==='review-rejects') { response.passed=false;response.checks[0].entity_numbers_units_dates_match=false; }
          return { json:response,usage:{prompt_tokens:100,completion_tokens:50} };
        }
        throw new Error(`Unexpected AI stage ${request.label}`);
      };
      const app=application(db.sql,{ai,fetcher:async url=>{
        assert.equal(String(url),sourceUrl);
        const metadata=mode==='missing-date'?'':`<meta property="article:published_time" content="${f.documents[0].publication.at}">`;
        return new Response(`<html><head>${metadata}</head><body><article>${sourceText}</article></body></html>`,{headers:{'content-type':'text/html'}});
      }});
      const {writer}=await initialize(db,app);
      const research=await app.load('lib/research/fact-pack.js');
      const [item]=await db.sql`INSERT INTO radar_items(external_id,title,summary,url,source_name,source_domain,ai_score,ai_section,candidate_type)
        VALUES('pipeline',${f.item.title},${sourceText},${sourceUrl},'Equinor','equinor.com',85,'Selskaper','kontrakt') RETURNING id`;
      const researched=await research.buildFactPackForRadarItem(item.id);
      if(['missing-date','research-declines'].includes(mode)) {
        assert.equal(researched.canWrite,false);
        assert.equal((await getCase(db.sql,item.id)).state,'blocked');
        await assert.rejects(writer.generateArticleDraftFromRadar(item.id),/faktagrunnlag/);
        assert.equal(calls.length,mode==='missing-date'?0:1);
        return;
      }
      assert.equal(researched.canWrite,true,JSON.stringify(researched));
      let result;
      if(mode==='verifier-unavailable-once') {
        await assert.rejects(writer.generateArticleDraftFromRadar(item.id),/temporarily unavailable/);
        const saved=await getCase(db.sql,item.id);
        assert.equal(saved.state,'failed');assert.equal(saved.step,'verify');
        assert.ok(saved.article_id);
        const {readCaseQueue}=await import('../lib/editorial/queue.mjs');
        const [run]=await db.sql`INSERT INTO editorial_runs(discovery_done,triage_done,selection_done) VALUES(true,true,true) RETURNING id`;
        await db.sql`UPDATE editorial_cases SET run_id=${run.id},retry_after=now()-interval '1 second' WHERE id=${saved.id}`;
        assert.equal((await readCaseQueue(db.sql,run.id,1)).verifyIds.length,1);
        const autopilot=await app.load('lib/autopilot/autopilot.js');
        assert.equal((await autopilot.runAutopilotStep({runId:run.id})).stage,'verification');
        result=await writer.generateArticleDraftFromRadar(item.id);
        assert.equal(calls.filter(c=>c.label==='DeepSeek V4 Pro artikkelmotor').length,1);
      } else result=await writer.generateArticleDraftFromRadar(item.id);
      const expectedCalls=mode==='verifier-unavailable-once'?4:3;
      assert.equal(calls.length,expectedCalls);
      assert.equal(result.tallValidert,mode!=='review-rejects');
      const again=await writer.generateArticleDraftFromRadar(item.id);
      assert.equal(again.cached,true);assert.equal(again.articleId,result.articleId);assert.equal(calls.length,expectedCalls);
      const editorialCase=await getCase(db.sql,item.id);
      assert.equal(editorialCase.state,'review');
      assert.equal((await db.sql`SELECT count(*)::int AS n FROM articles`)[0].n,1);
      assert.equal((await db.sql`SELECT count(*)::int AS n FROM ai_usage`)[0].n,3);
      assert.equal((await db.sql`SELECT count(*)::int AS n FROM source_journal WHERE radar_item_id=${item.id}`)[0].n,1);
      const published=await publishCaseArticle(db.sql,result.articleId,{manual:true});
      assert.equal(published.published,mode!=='review-rejects');
      if(mode!=='review-rejects') {
        assert.equal((await getCase(db.sql,item.id)).state,'published');
        assert.equal((await db.sql`SELECT slug FROM articles WHERE id=${result.articleId}`)[0].slug,result.slug);
      }
    } finally { await db.pg.close(); }
  });
}
