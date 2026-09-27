import { createHash } from 'node:crypto';
import { publicationEvidence } from '../editorial/contract.mjs';
export const NB_FEED='https://www.norges-bank.no/RSS/Pressemeldinger---Norges-Bank/';
export function plain(value='') {
 return String(value).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
  .replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&')
  .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim();
}
export function isDecisionUrl(value) {
 try { const u=new URL(value); return u.protocol==='https:' && u.hostname==='www.norges-bank.no'
  && !u.username && !u.password && !u.port && /^\/aktuelt\/nyheter\/Pressemeldinger\/20\d{2}\/20\d{2}-\d{2}-\d{2}-rente\/$/i.test(u.pathname) && !u.search; }
 catch {return false;}
}
export function decisionLinks(xml,now=Date.now()) {
 const links=[];
 for(const match of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
  const tag=name=>match[1].match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`,'i'))?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim();
  const url=tag('link'), publishedAt=tag('pubDate'); const age=now-new Date(publishedAt).getTime();
  if(isDecisionUrl(url)&&Number.isFinite(age)&&age>=-60000&&age<=2*3600000) links.push({url,publishedAt:new Date(publishedAt).toISOString()});
 }
 return links.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt));
}
export function parseDecision(html,{url,publishedAt,now=Date.now()}) {
 if(!isDecisionUrl(url)) throw new Error('UNTRUSTED_DECISION_URL');
 const headings=[...String(html).matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].filter(m=>/^Styringsrenten\s/i.test(plain(m[1])));
 if(headings.length!==1) throw new Error('AMBIGUOUS_RATE_HEADING');
 const title=plain(headings[0][1]);
 const m=title.match(/^Styringsrenten\s+(settes opp til|heves til|settes ned til|senkes til|holdes uendret på)\s+(\d{1,2}(?:[,.]\d{1,2})?)\s+prosent\.?$/i);
 if(!m) throw new Error('AMBIGUOUS_RATE_DECISION');
 const metadata=publicationEvidence(html);
 // RSS publication time is supplied only by the bank's fixed, official feed.
 const at=metadata?.at || publishedAt;
 if(!at || !Number.isFinite(new Date(at).getTime())) throw new Error('PUBLICATION_TIME_MISSING');
 if(metadata && publishedAt && Math.abs(new Date(at)-new Date(publishedAt))>60000) throw new Error('PUBLICATION_TIME_CONFLICT');
 const age=now-new Date(at).getTime();
 if(age< -60000||age>2*3600000) throw new Error('DECISION_NOT_FRESH');
 const dateInOslo=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
 if(!new URL(url).pathname.includes('/'+dateInOslo+'-rente/')) throw new Error('DECISION_DATE_CONFLICT');
 const full=String(html);const start=headings[0].index;const text=plain(full.slice(start)).split(/Kontakt:|Fant du det du lette etter/i)[0].slice(0,20000);
 const rate=Number(m[2].replace(',','.'));
 if(rate<0||rate>25 || !/komiteen besluttet|komité.*besluttet|besluttet.*styringsrenten/i.test(text)) throw new Error('DECISION_NOT_CONFIRMED');
 const direction=/opp|hev/i.test(m[1])?'up':/ned|senk/i.test(m[1])?'down':'unchanged';
 const transition=text.match(/styringsrenten\s+(?:opp|ned)\s+fra\s+(\d{1,2}(?:[,.]\d{1,2})?)\s+til\s+(\d{1,2}(?:[,.]\d{1,2})?)\s+prosent/i);
 let previous=null;
 if(direction!=='unchanged') {
  if(!transition||Number(transition[2].replace(',','.'))!==rate) throw new Error('RATE_TEXT_CONFLICT');
  previous=Number(transition[1].replace(',','.'));
  if((direction==='up'&&rate<=previous)||(direction==='down'&&rate>=previous)) throw new Error('RATE_DIRECTION_CONFLICT');
 } else if(!new RegExp(`(?:holde|holdes) styringsrenten uendret på ${m[2].replace(/[,.]/,'[,.]')} prosent`,'i').test(text)) throw new Error('UNCHANGED_RATE_NOT_CONFIRMED');
 const verb=direction==='up'?'hever':direction==='down'?'senker':'holder';
 const headline=`Norges Bank ${verb} styringsrenten ${direction==='unchanged'?'uendret på':'til'} ${m[2].replace('.',',')} prosent`;
 const fact=previous===null?headline+'.':`Norges Bank ${verb} styringsrenten fra ${String(previous).replace('.',',')} til ${m[2].replace('.',',')} prosent.`;
 return {url,source:'Norges Bank',kind:'rate-decision',headline,fact,rate,previous,direction,publishedAt:new Date(at).toISOString(),text,
  hash:createHash('sha256').update(text).digest('hex')};
}
export async function fetchOfficial(url,accept='text/html') {
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try {
  const response=await fetch(url,{cache:'no-store',redirect:'error',headers:{Accept:accept,'User-Agent':'KapitalstromNewsDesk/1.0'},signal:controller.signal});
  if(!response.ok) throw new Error(`OFFICIAL_SOURCE_HTTP_${response.status}`);
  const text=await response.text();if(text.length>2000000) throw new Error('OFFICIAL_SOURCE_TOO_LARGE');return text;
 } finally {clearTimeout(timer);}
}
