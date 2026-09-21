import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PRIMARY = new Set(['live.euronext.com','euronext.com','newsweb.no','norges-bank.no','data.norges-bank.no',
  'ssb.no','finanstilsynet.no','regjeringen.no','federalreserve.gov','ecb.europa.eu','boj.or.jp','opec.org','sec.gov']);
const SECONDARY = new Set(['dn.no','e24.no','finansavisen.no','reuters.com','bloomberg.com','ft.com','cnbc.com','wsj.com','apnews.com','nrk.no']);
// Review additions as company/domain mappings. A /news URL path is not proof.
const CORPORATE = new Map([
  ['equinor.com', /\bequinor\b/i], ['dnb.no', /\bdnb\b/i], ['ir.dnb.no', /\bdnb\b/i],
  ['kongsberg.com', /\bkongsberg\b/i], ['akerasa.com', /\baker\b/i], ['yara.com', /\byara\b/i],
  ['mowi.com', /\bmowi\b/i], ['salmar.no', /\bsalmar\b/i], ['telenor.com', /\btelenor\b/i],
  ['orkla.com', /\borkla\b/i], ['hydro.com', /\b(norsk hydro|hydro)\b/i], ['varenergi.no', /\b(vår energi|var energi)\b/i],
  ['nvidia.com', /\bnvidia\b/i], ['investor.nvidia.com', /\bnvidia\b/i], ['apple.com', /\bapple\b/i],
  ['microsoft.com', /\bmicrosoft\b/i], ['abc.xyz', /\b(alphabet|google)\b/i], ['ir.aboutamazon.com', /\bamazon\b/i],
  ['investor.atmeta.com', /\bmeta\b/i], ['ir.tesla.com', /\btesla\b/i], ['novonordisk.com', /\bnovo nordisk\b/i],
]);

export function sourceRoleFromUrl(value, item = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return { role: 'unknown', quality: 'unknown' };
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (PRIMARY.has(host)) return { role: 'primary', quality: 'official' };
    if (SECONDARY.has(host)) return { role: 'trusted_secondary', quality: 'high' };
    if (CORPORATE.get(host)?.test(`${item.title || ''} ${item.summary || ''}`)) return { role: 'primary', quality: 'corporate_official' };
    return { role: 'unknown', quality: 'unknown' };
  } catch { return { role: 'unknown', quality: 'unknown' }; }
}

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19].includes(b)));
  }
  // Only global-unicast IPv6; mapped IPv4, loopback and link-local fail closed.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
}

export function isIndexDocument(value) {
  try {
    const path = new URL(value).pathname;
    return /fomccalendars|\/index\.(html?|aspx)$|\/mpr_\d{4}\/?$|\/(news|newsroom|press|investors?|investor-relations)\/?$/i.test(path) || path === '/';
  } catch { return true; }
}

export async function fetchSourceDocumentBytes(value, item, { fetcher = fetch, resolver = lookup } = {}) {
  let url = value;
  const signal = AbortSignal.timeout(12_000);
  for (let redirect = 0; redirect <= 3; redirect++) {
    signal.throwIfAborted();
    if (sourceRoleFromUrl(url, item).role === 'unknown') throw new Error('Kildedomenet er ikke verifisert.');
    const host = new URL(url).hostname;
    let abortLookup;
    const timeout = new Promise((_, reject) => {
      abortLookup = () => reject(new Error('Kildeoppslag tok for lang tid.'));
      signal.addEventListener('abort', abortLookup, { once: true });
    });
    const addresses = await Promise.race([resolver(host, { all: true }), timeout])
      .finally(() => signal.removeEventListener('abort', abortLookup));
    if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error('Kilden peker til en intern eller reservert adresse.');
    const response = await fetcher(url, {
      redirect: 'manual', cache: 'no-store', signal,
      headers: { Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9', 'User-Agent': 'Kapitalstrom/1.0 (+source-verification)' },
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Kildeomdirigering mangler adresse.');
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) throw new Error(`Kilden svarte HTTP ${response.status}.`);
    const type = response.headers.get('content-type') || '';
    if (!/html|pdf|text\/plain/i.test(type)) throw new Error('Kilden har en ukjent dokumenttype.');
    const max = /pdf/i.test(type) ? 8_000_000 : 2_000_000;
    if (Number(response.headers.get('content-length') || 0) > max) { await response.body?.cancel(); throw new Error('Kildedokumentet er for stort.'); }
    const chunks = [];
    let size = 0;
    if (!response.body) throw new Error('Kilden svarte uten innhold.');
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > max) throw new Error('Kildedokumentet er for stort.');
      chunks.push(chunk);
    }
    return { url, type, bytes: Buffer.concat(chunks), fetched: true };
  }
  throw new Error('For mange kildeomdirigeringer.');
}
