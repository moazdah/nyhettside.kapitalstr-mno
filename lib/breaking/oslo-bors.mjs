import { createHash } from 'node:crypto';
import { plain } from './norges-bank.mjs';

// Company announcements from Euronext Oslo Børs (the former Newsweb list).
export const COMPANY_NEWS_URL = 'https://live.euronext.com/en/markets/oslo/equities/company-news';
export const FRESH_MS = 2 * 3600000;
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// Large, widely followed issuers. `match` is compared with the normalised issuer name.
export const LARGE_CAPS = [
  ['EQUINOR', 'Equinor'], ['DNB BANK', 'DNB'], ['KONGSBERG GRUPPEN', 'Kongsberg Gruppen'], ['AKER BP', 'Aker BP'],
  ['TELENOR', 'Telenor'], ['MOWI', 'Mowi'], ['NORSK HYDRO', 'Norsk Hydro'], ['YARA INTERNATIONAL', 'Yara'],
  ['ORKLA', 'Orkla'], ['STOREBRAND', 'Storebrand'], ['GJENSIDIGE', 'Gjensidige'], ['SALMAR', 'SalMar'],
  ['FRONTLINE', 'Frontline'], ['SUBSEA 7', 'Subsea 7'], ['VAR ENERGI', 'Vår Energi'], ['VÅR ENERGI', 'Vår Energi'],
  ['TOMRA', 'Tomra'], ['NORDIC SEMICONDUCTOR', 'Nordic Semiconductor'], ['SCHIBSTED', 'Schibsted'],
  ['AUTOSTORE', 'AutoStore'], ['AKER ASA', 'Aker'], ['AKER SOLUTIONS', 'Aker Solutions'], ['KONGSBERG MARITIME', 'Kongsberg Maritime'],
  ['LEROY SEAFOOD', 'Lerøy Seafood'], ['LERØY SEAFOOD', 'Lerøy Seafood'], ['SPAREBANK 1 SR-BANK', 'SpareBank 1 Sør-Norge'],
  ['SPAREBANK 1 SOR-NORGE', 'SpareBank 1 Sør-Norge'], ['SPAREBANK 1 SMN', 'SpareBank 1 SMN'], ['HAFNIA', 'Hafnia'],
  ['WALLENIUS WILHELMSEN', 'Wallenius Wilhelmsen'], ['NORWEGIAN AIR SHUTTLE', 'Norwegian'], ['ELKEM', 'Elkem'],
  ['BORREGAARD', 'Borregaard'], ['ENTRA', 'Entra'], ['SCATEC', 'Scatec'], ['NEL ASA', 'Nel'], ['BW LPG', 'BW LPG'],
  ['PROTECTOR FORSIKRING', 'Protector'], ['VEIDEKKE', 'Veidekke'], ['KID ASA', 'Kid'], ['EUROPRIS', 'Europris'],
];
const EXCLUDE = /(mandatory notification of trade|primary insider|close associate|share buy-?back|tilbakekjøp|buy-back|invitation|inviterer|presentation of (the )?(q|fourth|third|second|first|interim|annual)|will (publish|present|report)|to (publish|present)|reminder|webcast|conference call|financial calendar|finansiell kalender|annual general meeting|generalforsamling|ex[- ]dividend|key information relating to|total number of (voting rights|shares)|major shareholding|flagging|disclosure of large shareholding)/i;
const RESULTS = /\b(results?|resultat\w*|quarterly report|interim report|delårsrapport|kvartalsrapport|q[1-4]\s*20\d\d|(first|second|third|fourth) quarter|half[- ]year(ly)? report|annual report 20\d\d)\b/i;
const MATERIAL = /\b(profit warning|resultatvarsel|acquisition|acquires|oppkjøp|kjøper|merger|fusjon|takeover|offer for|tilbud|mandatory offer|budplikt|ceo|konsernsjef|steps down|går av|guidance|dividend|utbytte|contract|kontrakt|award|tildelt|strategic review|restructuring|bankruptcy|konkurs|recall|investigation|etterforskning)\b/i;
const MATERIAL_CATEGORY = /inside information|innsideinformasjon/i;
const RESULTS_CATEGORY = /(half yearly|annual|quarterly|interim) financial|financial report|regnskap/i;

const normalizeName = value => String(value || '').toUpperCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
export function largeCap(company) {
  const name = normalizeName(company);
  return LARGE_CAPS.find(([match]) => name.startsWith(normalizeName(match))) || null;
}

export function parsePublished(value) {
  const m = String(value || '').match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})\s+(CEST|CET)/i);
  const month = m && MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const date = new Date(`${m[3]}-${month}-${m[1].padStart(2, '0')}T${m[4]}:${m[5]}:00${m[6].toUpperCase() === 'CEST' ? '+02:00' : '+01:00'}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isCompanyNewsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'live.euronext.com' && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export function parseCompanyNews(html) {
  const rows = [];
  for (const rowMatch of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1];
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 5) continue;
    const publishedText = plain(cells[0]), company = plain(cells[1]), title = plain(cells[2]);
    const publishedAt = parsePublished(publishedText);
    if (!title || !company || !publishedAt) continue;
    const href = (rowHtml.match(/href=["']([^"']*\/company-news\/[^"']+)["']/i) || cells[2].match(/href=["']([^"']+)["']/i))?.[1];
    const url = !href ? null : /^https?:\/\//i.test(href) ? href : href.startsWith('/') ? `https://live.euronext.com${href}` : null;
    rows.push({ publishedText, publishedAt, company, title, sector: plain(cells[3]), category: plain(cells[4]), url });
  }
  return rows.slice(0, 50);
}

// Which announcements deserve the fast track, and as which kind.
export function classifyNotice(row) {
  const issuer = largeCap(row.company);
  if (!issuer || !row.url || !isCompanyNewsUrl(row.url)) return null;
  const text = `${row.title} ${row.category}`;
  if (EXCLUDE.test(text)) return null;
  if (RESULTS.test(row.title) || RESULTS_CATEGORY.test(row.category)) return { kind: 'exchange-results', issuer: issuer[1] };
  if (MATERIAL_CATEGORY.test(row.category) || MATERIAL.test(row.title)) return { kind: 'exchange-notice', issuer: issuer[1] };
  return null;
}

const shortTitle = value => { const t = String(value).replace(/\s+/g, ' ').trim(); return t.length > 150 ? `${t.slice(0, 147).replace(/\s+\S*$/, '')} …` : t; };
const slugPart = value => String(value).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// Deterministic flash: who published what and when. The announcement title is quoted,
// never interpreted. Figures follow only through the verified enrichment job.
export function noticeFlash(row, { now = Date.now() } = {}) {
  const classified = classifyNotice(row);
  if (!classified) return null;
  const age = now - row.publishedAt.getTime();
  if (age < -60000 || age > FRESH_MS) return null;
  const title = shortTitle(row.title);
  const results = classified.kind === 'exchange-results';
  const headline = results ? `${classified.issuer} har lagt fram tall: «${title}»` : `${classified.issuer} i børsmelding: «${title}»`;
  const fact = `${classified.issuer} publiserte en børsmelding på Oslo Børs med tittelen «${title}».`;
  const hash = createHash('sha256').update([row.url, row.company, row.title, row.publishedAt.toISOString()].join('|')).digest('hex');
  const body = [fact, results ? 'Kapitalstrøm går gjennom tallene, og saken oppdateres.' : 'Saken oppdateres når meldingen er gjennomgått.',
    `Kilde: [Børsmelding fra ${classified.issuer}](${row.url})`].join('\n\n');
  return { url: row.url, source: `Oslo Børs / ${classified.issuer}`, sourceKey: 'oslo-bors', kind: classified.kind, issuer: classified.issuer,
    headline, fact, body, summary: [fact], section: 'Selskaper', category: row.category, company: row.company,
    slug: `borsmelding-${slugPart(classified.issuer)}-${row.publishedAt.toISOString().slice(0, 10)}-${hash.slice(0, 8)}`,
    storyKey: `oslo-bors:${hash.slice(0, 24)}`, enrich: true, largeCap: true,
    publishedAt: row.publishedAt.toISOString(), checkedAt: new Date(now).toISOString(), text: null, hash };
}
