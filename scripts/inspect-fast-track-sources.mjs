// Diagnostics for source formats (read only). Prints table candidates and raw markup.
const out = {};
const get = async (url, init) => { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) }); return { status: r.status, text: await r.text(), url: r.url }; };
try {
  const v0 = await get('https://data.ssb.no/api/v0/no/table/?query=konsumprisindeks');
  out.ssbSearchV0 = v0.status === 200 ? JSON.parse(v0.text).slice(0, 25).map(t => ({ id: t.id, text: t.text, updated: t.updated })) : v0.status;
} catch (e) { out.ssbSearchV0 = String(e); }
try {
  const v2 = await get('https://data.ssb.no/api/pxwebapi/v2/tables?query=konsumprisindeks&lang=no&pageSize=25');
  out.ssbSearchV2 = v2.status === 200 ? JSON.parse(v2.text).tables?.map(t => ({ id: t.id, label: t.label, updated: t.updated, lastPeriod: t.lastPeriod, discontinued: t.discontinued })) : v2.status;
} catch (e) { out.ssbSearchV2 = String(e); }
try {
  const page = await get('https://live.euronext.com/en/markets/oslo/equities/company-news', { headers: { Accept: 'text/html' } });
  const rows = [...page.text.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map(m => m[0]).filter(r => /<td/i.test(r));
  out.euronext = { status: page.status, finalUrl: page.url, rows: rows.length, firstRows: rows.slice(0, 2).map(r => r.replace(/\s+/g, ' ').slice(0, 1500)),
    hrefs: [...new Set([...page.text.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]).filter(h => /news|press|release|listview/i.test(h)))].slice(0, 15),
    dataAttrs: [...new Set([...page.text.matchAll(/data-[a-z-]+=["'][^"']{0,80}["']/gi)].map(m => m[0]))].slice(0, 20) };
} catch (e) { out.euronext = String(e); }
try {
  const page = await get('https://live.euronext.com/en/markets/oslo/equities/company-news', { headers: { Accept: 'text/html' } });
  const nid = page.text.match(/data-node-nid="(\d+)"/)?.[1];
  out.nid = nid; out.nidCandidates = {};
  for (const path of [`/en/listview/company-press-release/${nid}`, `/ajax/node/company-press-release/${nid}`, `/en/ajax/node/company-press-release/${nid}`, `/node/${nid}`, `/en/node/${nid}`]) {
    try { const r = await get('https://live.euronext.com' + path, { headers: { Accept: 'text/html' } });
      const text = r.text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      out.nidCandidates[path] = { status: r.status, finalUrl: r.url, textLength: text.length, excerpt: text.slice(0, 600), hasPublished: /article:published_time|datePublished/.test(r.text) };
    } catch (e) { out.nidCandidates[path] = String(e); }
  }
  const js = page.text.match(/standardRightCompanyPressRelease[\s\S]{0,400}/g)?.slice(0, 3);
  out.modalHints = js;
  const settings = page.text.match(/drupal-settings-json">([\s\S]*?)<\/script>/)?.[1] || '';
  out.settingsHints = [...settings.matchAll(/"[^"]*(press|ajax|node)[^"]*"/gi)].map(m => m[0]).slice(0, 20);
} catch (e) { out.nid = String(e); }
for (const table of ['14700', '14706']) {
  try { const meta = JSON.parse((await get('https://data.ssb.no/api/v0/no/table/' + table)).text);
    out['ssbMeta' + table] = meta.variables.map(v => ({ code: v.code, time: v.time, elimination: v.elimination, values: v.values.slice(0, 12), texts: v.valueTexts.slice(0, 12) }));
  } catch (e) { out['ssbMeta' + table] = String(e); }
}
delete out.ssbSearchV0; delete out.ssbSearchV2;
console.log(JSON.stringify(out, null, 1));
