import { createHash } from 'crypto';
import { db } from '../db';

const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MAX_RSS_AGE_HOURS = 18;

const RSS_FEEDS = [
  {
    name: 'Dagens Næringsliv – RSS',
    url: 'https://services.dn.no/api/feed/rss/',
    kind: 'rss',
  },
  {
    name: 'E24 – Børs og finans',
    url: 'https://e24.no/rss2/?seksjon=boers-og-finans',
    kind: 'rss',
  },
  {
    name: 'E24 – Makro og politikk',
    url: 'https://e24.no/rss2/?seksjon=makro-og-politikk',
    kind: 'rss',
  },
  {
    name: 'E24 – Aksjetips',
    url: 'https://e24.no/rss2/?seksjon=aksjetips',
    kind: 'rss',
  },
  {
    name: 'Federal Reserve – pengepolitikk',
    url: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
    kind: 'official-rss',
  },
  {
    name: 'ECB – nyheter og presse',
    url: 'https://www.ecb.europa.eu/rss/press.html',
    kind: 'official-rss',
  },
];

const GDELT_QUERIES = [
  {
    name: 'GDELT – Norge/Norden finans',
    timespan: '8h',
    query: '(Norway OR Norwegian OR NOK OR "Oslo Bors" OR "Norges Bank") (economy OR market OR inflation OR "interest rate" OR earnings OR acquisition OR oil OR shipping OR salmon OR analyst OR "price target")',
  },
  {
    name: 'GDELT – globale sentralbanker og makro',
    timespan: '8h',
    query: '("Federal Reserve" OR FOMC OR ECB OR "Bank of Japan" OR BOJ OR "Bank of England" OR CPI OR PCE OR payrolls OR inflation OR PMI OR GDP) (rates OR economy OR market OR stocks OR bonds OR currency)',
  },
  {
    name: 'GDELT – USA megacap og AI',
    timespan: '18h',
    query: '(Nvidia OR Apple OR Microsoft OR Alphabet OR Google OR Amazon OR Meta OR Tesla OR Broadcom OR AMD OR Oracle OR Salesforce OR Netflix) (earnings OR revenue OR profit OR EPS OR guidance OR forecast OR results OR shares)',
  },
  {
    name: 'GDELT – globale storselskaper',
    timespan: '18h',
    query: '("TSMC" OR ASML OR Samsung OR "Novo Nordisk" OR "Eli Lilly" OR JPMorgan OR "Goldman Sachs" OR "Morgan Stanley" OR Exxon OR Chevron OR Shell OR BP OR Airbus OR Boeing OR Berkshire) (earnings OR revenue OR profit OR guidance OR acquisition OR shares OR results)',
  },
  {
    name: 'GDELT – resultater og guiding',
    timespan: '18h',
    query: '("quarterly results" OR earnings OR "profit warning" OR "revenue forecast" OR "raises guidance" OR "cuts guidance" OR "beats estimates" OR "misses estimates") (shares OR stock OR company OR investors)',
  },
  {
    name: 'GDELT – markedsbevegelser og oppmerksomhet',
    timespan: '8h',
    query: '("shares surge" OR "shares jump" OR "shares plunge" OR "shares slump" OR "stock soars" OR "stock tumbles" OR selloff OR rally OR "record high") (earnings OR deal OR forecast OR market OR billion)',
  },
  {
    name: 'GDELT – oppkjøp, kriser og store penger',
    timespan: '18h',
    query: '(acquisition OR takeover OR merger OR bankruptcy OR restructuring OR default OR IPO OR "capital raise" OR "job cuts") (billion OR shares OR company OR investors)',
  },
  {
    name: 'GDELT – råvarer, energi og krypto',
    timespan: '8h',
    query: '(Brent OR oil OR OPEC OR natural gas OR gold OR copper OR Bitcoin OR Ethereum) (surge OR plunge OR price OR supply OR demand OR sanctions OR market)',
  },
];

const STRONG_FINANCE_PATTERNS = [
  /\baksj(?:e|en|er|ene|ekurs|emarked)\b/i,
  /\bbørs(?:en|er|ene|notert|melding)?\b/i,
  /\b(oslo børs|euronext|wall street|nasdaq|s&p 500|dow jones|stoxx|dax)\b/i,
  /\b(resultat|resultater|kvartalstall|årsresultat|driftsresultat|ebitda|ebit|guiding|resultatvarsel|earnings|revenue|sales|profit|net income|eps|guidance|forecast|outlook|margin|free cash flow|quarterly results|annual results)\b/i,
  /\b(beats? estimates|miss(?:es|ed)? estimates|above estimates|below estimates|raises? guidance|cuts? guidance|profit warning)\b/i,
  /\b(oppkjøp|fusjon|bud|budplikt|overtakelse|acquisition|merger|takeover)\b/i,
  /\b(emisjon|kapitalinnhenting|fortrinnsrett|rights issue|tilbakekjøp|utbytte)\b/i,
  /\b(kursmål|kjøpsanbefaling|salgsanbefaling|analytiker|meglerhus|oppgradering|nedgradering)\b/i,
  /\b(rente|renter|rentekutt|renteheving|styringsrente|rentemøte|interest rate|rate cut|rate hike)\b/i,
  /\b(inflasjon|kpi|cpi|pce|prisvekst|kjerneinflasjon)\b/i,
  /\b(valuta|krone|norske kroner|nok\b|eur\/nok|usd\/nok|dollar|euro)\b/i,
  /\b(obligasjon|obligasjoner|bond|bonds|yield|statsrente|kredittspread|kreditt)\b/i,
  /\b(brent|oljepris|olje|gasspris|naturgass|opec)\b/i,
  /\b(shipping|tørrbulk|tankrater|fraktrater|offshore)\b/i,
  /\b(laks|sjømat|salmon)\b/i,
  /\b(bank|banker|bankene|finansiering|refinansiering|gjeld|lån|likviditet)\b/i,
  /\b(kontrakt|ordre|ordrebok|avtaleverdi|milliardkontrakt)\b/i,
  /\b(konkurs|rekonstruksjon|betalingsstans|insolvens|bankruptcy|restructuring|default|chapter 11)\b/i,
  /\b(shares? (?:surge|jump|soar|rally|plunge|slump|tumble|drop)|stock (?:surges?|jumps?|soars?|plunges?|slumps?|tumbles?)|selloff|record high|record low)\b/i,
  /\b(10-q|10-k|8-k|6-k|20-f|sec filing|annual report|quarterly report)\b/i,
  /\b(fed|federal reserve|ecb|esb|norges bank|bank of england)\b/i,
  /\b(bnp|gdp|pmi|arbeidsledighet|ledighet|sysselsetting|nonfarm|jobbtall|lønnsvekst)\b/i,
  /\b(handelstoll|tollsatser|tariff|sanksjoner)\b/i,
  /\b(bitcoin|ethereum|krypto|crypto)\b/i,
  /\b(ai chips?|semiconductor|semiconductors|data center|datacenter|gpu|foundry)\b/i,
  /\b(ipo|initial public offering|market cap|market value|buyback|share repurchase|dividend)\b/i,
];

const GLOBAL_COMPANY_PATTERNS = [
  /\b(nvidia|apple|microsoft|alphabet|google|amazon|meta|tesla|broadcom|amd|oracle|salesforce|netflix)\b/i,
  /\b(tsmc|taiwan semiconductor|asml|samsung electronics|sony|toyota|softbank)\b/i,
  /\b(jpmorgan|goldman sachs|morgan stanley|bank of america|citigroup|wells fargo|hsbc|ubs|deutsche bank)\b/i,
  /\b(berkshire hathaway|exxon|chevron|shell|bp|totalenergies|aramco)\b/i,
  /\b(novo nordisk|eli lilly|roche|novartis|astrazeneca|pfizer|merck)\b/i,
  /\b(airbus|boeing|lvmh|hermes|volkswagen|mercedes-benz|bmw|siemens|sap)\b/i,
];

const ATTENTION_PATTERNS = [
  /\b(billion|milliard|trillion|record|rekord|largest|biggest|største|historic|historisk)\b/i,
  /\b(surge|soar|jump|plunge|slump|tumble|rally|selloff|kollaps|stuper|skyter fart)\b/i,
  /\b(ceo|cfo|founder|grunnlegger|resigns?|steps down|går av|fired|sparket)\b/i,
  /\b(profit warning|guidance cut|guidance raise|beats estimates|misses estimates|unexpected|uventet)\b/i,
];

const BROAD_ECONOMY_PATTERNS = [
  /\bøkonomi(?:en|sk|ske)?\b/i,
  /\bmarked(?:et|er|ene)?\b/i,
  /\bnæringsliv\b/i,
  /\bbedrift(?:er|ene)?\b/i,
  /\bselskap(?:et|er|ene)?\b/i,
  /\binvestor(?:er|ene)?\b/i,
  /\binvestering(?:er|ene)?\b/i,
  /\bskatt(?:e|en|er|ene)?\b/i,
  /\bbudsjett\b/i,
  /\benergi(?:pris|priser|marked)?\b/i,
  /\bråvare(?:r|marked)?\b/i,
  /\beiendom(?:smarked|spris|spriser)?\b/i,
];

const NOISE_PATTERNS = [
  /\b(reise|reisemål|ferie|helgetur|hotellguide|restaurant|oppskrift|mat og drikke)\b/i,
  /\b(fotball|landslaget|premier league|champions league|sport)\b/i,
  /\b(kjendis|film|tv-serie|musikk|podkast-stjerne|podcast-stjerne)\b/i,
  /\b(skole|elever|lærer|pisa)\b/i,
];

export async function ensureRadarSchema(sql = db()) {
  await sql`
    CREATE TABLE IF NOT EXISTS radar_items (
      id BIGSERIAL PRIMARY KEY,
      external_id TEXT UNIQUE NOT NULL,
      source_name TEXT NOT NULL,
      source_domain TEXT,
      source_kind TEXT NOT NULL DEFAULT 'discovery',
      title TEXT NOT NULL,
      summary TEXT,
      url TEXT NOT NULL,
      image_url TEXT,
      published_at TIMESTAMPTZ,
      discovered_at TIMESTAMPTZ DEFAULT NOW(),
      ai_score INT,
      ai_section TEXT,
      ai_reason TEXT,
      ai_model TEXT,
      ai_scored_at TIMESTAMPTZ,
      candidate_type TEXT,
      credit_required BOOLEAN DEFAULT FALSE,
      next_step TEXT,
      primary_source_status TEXT DEFAULT 'unverified',
      primary_source_name TEXT,
      primary_source_url TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS source_journal (
      id BIGSERIAL PRIMARY KEY,
      radar_item_id BIGINT REFERENCES radar_items(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      source_name TEXT NOT NULL,
      url TEXT,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_radar_items_recent ON radar_items (published_at DESC NULLS LAST, discovered_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_radar_items_score ON radar_items (ai_score DESC NULLS LAST, published_at DESC NULLS LAST)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_source_journal_item ON source_journal (radar_item_id, created_at DESC)`;
}

function decodeXml(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function stripHtml(value = '') {
  return decodeXml(String(value).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const match = String(block).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function linkFromBlock(block) {
  const normal = tag(block, 'link');
  if (normal && /^https?:/i.test(stripHtml(normal))) return stripHtml(normal);
  const href = String(block).match(/<link\\b[^>]*href=["']([^"']+)["'][^>]*\\/?>(?:<\\/link>)?/i);
  return href ? decodeXml(href[1]).trim() : '';
}

function cleanUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|cmpid$|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return String(raw || '').trim();
  }
}

function domainOf(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function externalId(url, title = '') {
  return createHash('sha256').update(`${cleanUrl(url)}|${title}`).digest('hex').slice(0, 48);
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isRecentEnough(date, maxHours = MAX_RSS_AGE_HOURS) {
  if (!date) return true;
  const ageMs = Date.now() - new Date(date).getTime();
  return ageMs <= maxHours * 60 * 60 * 1000;
}

function countMatches(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
}

export function isRadarItemRelevant(item) {
  const text = `${item?.title || ''} ${item?.summary || ''}`.replace(/\s+/g, ' ').trim();
  const sourceName = String(item?.sourceName || item?.source_name || '');
  if (!text) return false;

  if (/E24 – Aksjetips/i.test(sourceName)) return true;

  const strong = countMatches(text, STRONG_FINANCE_PATTERNS);
  const broad = countMatches(text, BROAD_ECONOMY_PATTERNS);
  const noise = countMatches(text, NOISE_PATTERNS);
  const globalCompany = countMatches(text, GLOBAL_COMPANY_PATTERNS);
  const attention = countMatches(text, ATTENTION_PATTERNS);

  if (globalCompany >= 1 && (strong >= 1 || attention >= 1)) return true;
  if (strong >= 2) return true;
  if (strong >= 1 && noise === 0) return true;
  if (strong >= 1 && broad >= 1) return true;

  if (/GDELT/i.test(sourceName)) return (strong >= 1 || broad >= 1 || (globalCompany >= 1 && attention >= 1)) && noise === 0;
  if (/Federal Reserve|ECB/i.test(sourceName)) return strong >= 1 || broad >= 1;
  if (/E24 – Børs og finans/i.test(sourceName)) return broad >= 2 && noise === 0;
  if (/E24 – Makro og politikk/i.test(sourceName)) return broad >= 2 && noise === 0;
  if (/Dagens Næringsliv/i.test(sourceName)) return broad >= 2 && noise === 0;

  return false;
}

function parseRss(xml, feed) {
  const items = [];
  const blocks = [
    ...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ];

  for (const match of blocks) {
    const block = match[1];
    const title = stripHtml(tag(block, 'title'));
    const link = cleanUrl(linkFromBlock(block) || tag(block, 'guid'));
    const summary = stripHtml(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content')).slice(0, 900);
    const published = parseDate(tag(block, 'pubDate') || tag(block, 'dc:date') || tag(block, 'published') || tag(block, 'updated'));
    if (!title || !link || !isRecentEnough(published, feed.maxAgeHours || MAX_RSS_AGE_HOURS)) continue;
    const item = {
      sourceName: feed.name,
      sourceKind: feed.kind || 'rss',
      sourceDomain: domainOf(link),
      title,
      summary,
      url: link,
      imageUrl: null,
      publishedAt: published,
    };
    if (isRadarItemRelevant(item)) items.push(item);
  }
  return items.slice(0, 80);
}

function parseGdeltDate(value) {
  const s = String(value || '');
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})?Z?$/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}Z`);
  return parseDate(s);
}

async function fetchRssFeed(feed) {
  const response = await fetch(feed.url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
      'User-Agent': 'Kapitalstrom/1.0 (+editorial news radar)',
    },
  });
  if (!response.ok) throw new Error(`${feed.name}: HTTP ${response.status}`);
  return parseRss(await response.text(), feed);
}

async function fetchGdelt(queryConfig) {
  const url = new URL(GDELT_URL);
  url.searchParams.set('query', queryConfig.query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('maxrecords', '60');
  url.searchParams.set('timespan', queryConfig.timespan || '8h');
  url.searchParams.set('sort', 'datedesc');
  url.searchParams.set('format', 'json');

  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json', 'User-Agent': 'Kapitalstrom/1.0 (+editorial news radar)' },
  });
  if (!response.ok) throw new Error(`${queryConfig.name}: HTTP ${response.status}`);
  const payload = await response.json();
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  return articles.map((a) => ({
    sourceName: a.domain ? `${queryConfig.name} · ${a.domain}` : queryConfig.name,
    sourceKind: 'news-index',
    sourceDomain: a.domain || domainOf(a.url),
    title: stripHtml(a.title),
    summary: [a.sourcecountry, a.language].filter(Boolean).join(' · '),
    url: cleanUrl(a.url),
    imageUrl: a.socialimage || null,
    publishedAt: parseGdeltDate(a.seendate),
  })).filter((a) => a.title && a.url && isRadarItemRelevant(a));
}

async function registerSource(sql, name, type, url) {
  await sql`
    INSERT INTO sources (navn, type, url, aktiv, intervall_min)
    SELECT ${name}, ${type}, ${url}, true, 60
    WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = ${url})
  `;
  await sql`
    UPDATE sources SET navn = ${name}, type = ${type}, aktiv = true, intervall_min = 60
    WHERE url = ${url}
  `;
}

async function insertRadarItem(sql, item) {
  if (!isRadarItemRelevant(item)) return 0;
  const id = externalId(item.url, item.title);
  const rows = await sql`
    INSERT INTO radar_items (
      external_id, source_name, source_domain, source_kind, title, summary,
      url, image_url, published_at, discovered_at
    )
    VALUES (
      ${id}, ${item.sourceName}, ${item.sourceDomain || null}, ${item.sourceKind},
      ${item.title}, ${item.summary || null}, ${item.url}, ${item.imageUrl || null},
      ${item.publishedAt ? item.publishedAt.toISOString() : null}, now()
    )
    ON CONFLICT (external_id) DO NOTHING
    RETURNING id
  `;
  if (!rows.length) return 0;
  await sql`
    INSERT INTO source_journal (radar_item_id, role, source_name, url, note)
    VALUES (${rows[0].id}, 'discovery', ${item.sourceName}, ${item.url}, 'Oppdagelseskilde. Må ikke behandles som primærkilde uten egen verifisering.')
  `;
  return 1;
}

export async function pruneRadarNoise(sql = db()) {
  await ensureRadarSchema(sql);
  const rows = await sql`
    SELECT id, source_name, title, summary
    FROM radar_items
    WHERE ai_score IS NULL
    ORDER BY discovered_at DESC
    LIMIT 500
  `;
  const remove = rows.filter((row) => !isRadarItemRelevant(row)).map((row) => Number(row.id));
  let removed = 0;
  for (const id of remove) {
    const deleted = await sql`DELETE FROM radar_items WHERE id = ${id} AND ai_score IS NULL RETURNING id`;
    removed += deleted.length;
  }
  return removed;
}

export async function runNewsRadar() {
  const sql = db();
  await ensureRadarSchema(sql);
  const prunedBefore = await pruneRadarNoise(sql);

  let seen = 0;
  let inserted = 0;
  const errors = [];

  const rssResults = await Promise.allSettled(RSS_FEEDS.map(fetchRssFeed));
  for (let i = 0; i < rssResults.length; i += 1) {
    const feed = RSS_FEEDS[i];
    await registerSource(sql, feed.name, 'rss', feed.url);
    const result = rssResults[i];
    if (result.status === 'rejected') {
      errors.push(result.reason?.message || `${feed.name}: ukjent feil`);
      continue;
    }
    seen += result.value.length;
    for (const item of result.value) inserted += await insertRadarItem(sql, item);
    await sql`UPDATE sources SET sist_hentet = now() WHERE url = ${feed.url}`;
  }

  await registerSource(sql, 'GDELT – global nyhetsindeks', 'news-index', GDELT_URL);
  for (const query of GDELT_QUERIES) {
    try {
      const items = await fetchGdelt(query);
      seen += items.length;
      for (const item of items) inserted += await insertRadarItem(sql, item);
    } catch (error) {
      errors.push(error?.message || `${query.name}: ukjent feil`);
    }
  }
  await sql`UPDATE sources SET sist_hentet = now() WHERE url = ${GDELT_URL}`;
  const prunedAfter = await pruneRadarNoise(sql);

  return { seen, inserted, pruned: prunedBefore + prunedAfter, errors };
}
