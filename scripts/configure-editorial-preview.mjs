// Credentials move only between this repository's runner and its Vercel project.
const project='prj_dt9X67WnEvEROT1WntALIWd5I68T';
const team='team_RbPY2JdK0IeLUf78YlfJUaxg';
const branch='codex/redaksjon-sammenheng';
try {
  const direct=new URL(process.env.EDITORIAL_TEST_DATABASE_URL_UNPOOLED);
  if(!direct.hostname.endsWith('.neon.tech')) throw new Error('EXPECTED_NEON_ENDPOINT');
  direct.hostname=direct.hostname.replace('-pooler.','.');
  const pooled=new URL(direct); pooled.hostname=pooled.hostname.replace('.', '-pooler.');
  if(!process.env.DEEPSEEK_API_KEY||!process.env.VERCEL_TOKEN) throw new Error('MISSING_SECRET');
  for(const [key,value] of Object.entries({DATABASE_URL:pooled.toString(),DATABASE_URL_UNPOOLED:direct.toString(),
    DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY,EDITORIAL_AUTOPUBLISH_V1:'false'})) {
    const response=await fetch(`https://api.vercel.com/v10/projects/${project}/env?teamId=${team}&upsert=true`,{
      method:'POST',headers:{Authorization:`Bearer ${process.env.VERCEL_TOKEN}`,'Content-Type':'application/json'},
      body:JSON.stringify({key,value,type:key==='EDITORIAL_AUTOPUBLISH_V1'?'plain':'sensitive',target:['preview'],gitBranch:branch}),
      signal:AbortSignal.timeout(15000)});
    const body=await response.json();
    if(!response.ok||body.failed?.length) throw new Error(`ENV_WRITE_FAILED_${response.status}`);
    console.log(JSON.stringify({configured:key,target:'preview',branch}));
  }
} catch(error) {
  console.error(JSON.stringify({ok:false,stage:'configure_preview',code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'REQUEST_FAILED'}));
  process.exitCode=1;
}
