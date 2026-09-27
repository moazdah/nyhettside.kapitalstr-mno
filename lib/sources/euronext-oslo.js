import { createHash } from 'crypto';
import { db } from '../db';
import { parseCompanyNews } from '../breaking/oslo-bors.mjs';

const SOURCE_NAME = 'Euronext Oslo Børs – selskapsmeldinger';
const SOURCE_URL = 'https://live.euronext.com/en/markets/oslo/equities/company-news';

function externalId(item) {
  return createHash('sha256')
    .update([item.publishedText, item.company, item.title].join('|'))
    .digest('hex')
    .slice(0, 40);
}

// Parsing is shared with the fast track so both read the list identically.
function parseRows(html) {
  return parseCompanyNews(html).map(item => ({ ...item, url: item.url || SOURCE_URL }));
}

async function ensureSource(sql) {
  await sql`
    INSERT INTO sources (navn, type, url, aktiv, intervall_min)
    SELECT ${SOURCE_NAME}, 'scrape', ${SOURCE_URL}, true, 15
    WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = ${SOURCE_URL})
  `;
  await sql`
    UPDATE sources
    SET navn = ${SOURCE_NAME}, type = 'scrape', aktiv = true, intervall_min = 15
    WHERE url = ${SOURCE_URL}
  `;
  const [source] = await sql`SELECT id FROM sources WHERE url = ${SOURCE_URL} LIMIT 1`;
  return source;
}

export async function syncEuronextOsloNews() {
  const response = await fetch(SOURCE_URL, {
    cache: 'no-store',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Kapitalstrom/1.0 (+editorial market-news monitor)',
    },
  });
  if (!response.ok) throw new Error(`Euronext Oslo Børs: HTTP ${response.status}`);

  const html = await response.text();
  const items = parseRows(html);
  if (!items.length) throw new Error('Fant ingen selskapsmeldinger på Euronext Oslo Børs-siden.');

  const sql = db();
  const source = await ensureSource(sql);
  let inserted = 0;

  for (const item of items) {
    const id = externalId(item);
    const body = [
      `Selskap: ${item.company}`,
      item.category ? `Kategori: ${item.category}` : null,
      item.sector ? `Sektor: ${item.sector}` : null,
      `Tittel: ${item.title}`,
    ].filter(Boolean).join('\n');

    const result = await sql`
      INSERT INTO raw_items (kilde_id, ekstern_id, tittel, innhold, publisert, url, behandlet)
      VALUES (${source.id}, ${id}, ${item.title}, ${body}, ${item.publishedAt.toISOString()}, ${item.url}, false)
      ON CONFLICT (kilde_id, ekstern_id) DO NOTHING
      RETURNING id
    `;
    inserted += result.length;
  }

  await sql`UPDATE sources SET sist_hentet = now() WHERE id = ${source.id}`;
  return { seen: items.length, inserted };
}
