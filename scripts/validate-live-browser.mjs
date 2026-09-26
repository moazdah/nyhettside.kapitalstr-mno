import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { chromium } from 'playwright';
const sql=neon(process.env.EDITORIAL_TEST_DATABASE_URL_UNPOOLED);
const marker=`browser-${randomUUID()}`;
let browser;
try {
  const [first]=await sql`INSERT INTO feed(tekst,headline,summary,status,tidspunkt,generated_by)
    VALUES(${marker+' first'},${marker+' first'},'Testmelding','live',now(),${marker}) RETURNING id,tidspunkt`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({baseURL:'http://localhost:3000',viewport:{width:1280,height:900}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://localhost:3000',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:marker+' first',exact:true}).waitFor();
  const before=await page.locator('.liveRailStory').count();
  assert.ok(before<=12);
  assert.equal(await page.locator('.liveRailStoryTrack').evaluate(el=>getComputedStyle(el).display),'flex');
  await page.getByRole('button',{name:'Åpne nyhetsstrømmen'}).click();
  await page.locator('.liveRail.expanded').waitFor();
  const [second]=await sql`INSERT INTO feed(tekst,headline,summary,status,tidspunkt,generated_by)
    VALUES(${marker+' second'},${marker+' second'},'Ny melding mens siden er åpen','live',now(),${marker}) RETURNING id`;
  // Real 30-second polling, no navigation or reload.
  await page.getByRole('heading',{name:marker+' second',exact:true}).waitFor({timeout:45000});
  assert.ok(await page.locator('.liveRail.expanded').count());
  const response=await page.request.get('/api/live');
  assert.match(response.headers()['cache-control'],/no-store/);
  const body=await response.json();
  assert.ok(body.items.length<=12);
  const saved=body.items.find(item=>String(item.id)===String(first.id));
  assert.equal(new Date(saved.tidspunkt).getTime(),new Date(first.tidspunkt).getTime());
  await sql`UPDATE feed SET status='expired' WHERE id=${Number(second.id)}`;
  await page.getByRole('heading',{name:marker+' second',exact:true}).waitFor({state:'detached',timeout:45000});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.locator('.liveRailStoryViewport').evaluate(el=>el.scrollWidth>=el.clientWidth));
  assert.equal(await page.locator('[data-nextjs-dialog]').count(),0);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'live-rail-mobile.png'});
  await page.goto('http://localhost:3000/redaksjon?tab=radar',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Nyhetsmotor og publisering'}).waitFor();
  await page.getByText('Siste vellykkede puls:',{exact:false}).waitFor();
  await page.getByText('Gjennomgangsmodus: Fullartikler krever din godkjenning.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  assert.equal((await page.request.get('/api/cron/engine')).status(),401);
  const inactive=await page.request.get('/api/cron/engine',{headers:{Authorization:'Bearer engine-ci-only'}});
  assert.equal((await inactive.json()).reason,'not_activated');
  console.log(JSON.stringify({ok:true,polling:true,expiry:true,stableTimestamp:true,max12:true,horizontal:true,noPageErrors:true}));
} catch(error) {
  console.error(JSON.stringify({ok:false,kind:error.name,message:String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[REDACTED]').slice(0,350)}));
  process.exitCode=1;
} finally {
  await browser?.close();
  await sql`DELETE FROM feed WHERE generated_by=${marker}`;
}
