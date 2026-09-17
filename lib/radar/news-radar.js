import { createHash } from 'crypto';
import { db } from '../db';

const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

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
];

const GDELT_QUERIES = [
  {
    name: 'GDELT – Norge/Norden finans',
    query: '(Norway OR Norwegian OR NOK OR "Oslo Bors" OR "Norges Bank") (economy OR market OR inflation OR "interest rate" OR earnings OR acquisition OR oil OR shipping OR salmon OR analyst OR "price target")',
  },
  {
    name: 'GDELT – global makro og markeder',
    query: '("Federal Reserve" OR ECB OR "Bank of England" OR OPEC OR "Brent oil" OR "US inflation" OR "US jobs" OR "S&P 500" OR Nasdaq) (market OR economy OR rates OR stocks OR bonds)',
  },
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

function parseRss(xml, sourceName) {
  const items = [];
  for (const match of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const title = stripHtml(tag(block, 'title'));
    const link = cleanUrl(tag(block, 'link') || tag(block, 'guid'));
    const summary = stripHtml(tag(block, 'description')).slice(0, 700);
    const published = parseDate(tag(block, 'pubDate') || tag(block, 'dc:date'));
    if (!title || !link) continue;
    items.push({
      sourceName,
      sourceKind: 'rss',
      sourceDomain: domainOf(link),
      title,
      summary,
      url: link,
      imageUrl: null,
      publishedAt: published,
    });
  }
  return items.slice(0, 60);
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
  return parseRss(await response.text(), feed.name);
}

async function fetchGdelt(queryConfig) {
  const url = new URL(GDELT_URL);
  url.searchParams.set('query', queryConfig.query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('maxrecords', '75');
  url.searchParams.set('timespan', '2h');
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
  })).filter((a) => a.title && a.url);
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

export async function runNewsRadar() {
  const sql = db();
  await ensureRadarSchema(sql);

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

  return { seen, inserted, errors };
}
