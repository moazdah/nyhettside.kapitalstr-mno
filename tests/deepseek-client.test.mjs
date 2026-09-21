import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../lib/ai/deepseek-client.js',import.meta.url),'utf8');
async function client(body) {
  let payload;
  const context=vm.createContext({process:{env:{DEEPSEEK_API_KEY:'test-only'}},AbortController,setTimeout,clearTimeout,
    fetch:async(_url,options)=>{payload=JSON.parse(options.body);return {ok:true,json:async()=>body};}});
  const module=new vm.SourceTextModule(source,{context});
  await module.link(()=>{throw new Error('Unexpected dependency');});await module.evaluate();
  return {request:module.namespace.deepSeekJsonRequest,payload:()=>payload};
}
test('Truncated provider output is rejected even if its JSON parses',async()=>{
  const c=await client({choices:[{finish_reason:'length',message:{content:'{"ok":true}'}}],usage:{completion_tokens:4200}});
  await assert.rejects(c.request({system:'JSON',user:'test',retries:0}),/tokengrensen/);
});
test('Reasoning-only response cannot become article data or leak reasoning',async()=>{
  const c=await client({choices:[{finish_reason:'stop',message:{content:' ',reasoning_content:'PRIVATE REASONING'}}],usage:{completion_tokens:4200}});
  await assert.rejects(c.request({system:'JSON',user:'test',retries:0}),error=>error.message.includes('uten JSON')&&!error.message.includes('PRIVATE REASONING'));
});
test('Structured non-thinking request returns provider JSON and usage',async()=>{
  const c=await client({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}],usage:{completion_tokens:5}});
  const result=await c.request({system:'JSON',user:'test',retries:0,thinking:false});
  assert.equal(result.json.ok,true);assert.equal(result.usage.completion_tokens,5);
  assert.equal(c.payload().thinking.type,'disabled');
});
