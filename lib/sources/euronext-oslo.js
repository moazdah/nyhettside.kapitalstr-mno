import { createHash } from 'crypto';
import { db } from '../db';

const SOURCE_NAME = 'Euronext Oslo Børs – selskapsmeldinger';
const SOURCE_URL = 'https://live.euronext.com/en/markets/oslo/equities/company-news';

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function textFromHtml(value) {
  return decodeHtml(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(href) {
  if (!href) return SOURCE_URL;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return `https://live.euronext.com${href}`;
  return SOURCE_URL;
}

function parsePublished(value) {
  const match = String(value || '').match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})\s+(CEST|CET)/i);
  if (!match) return null;
  const [, day, monthName, year, hour, minute, zone] = match;
  const month = MONTHS[monthName[0].toUpperCase() + monthName.slice(1, 3).toLowerCase()];
  if (!month) return null;
  const offset = zone.toUpperCase() === 'CEST' ? '+02:00' : '+01:00';
  const iso = `${year}-${month}-${String(day).padStart(2, '0')}T${hour}:${minute}:00${offset}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function externalId(item) {
  return createHash('sha256')
    .update([item.publishedText, item.company, item.title].join('|'))
    .digest('hex')
    .slice(0, 40);
}

function parseRows(html) {
  const rows = [];
  for (const rowMatch of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1];
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 5) continue;

    const publishedText = textFromHtml(cells[0]);
    const company = textFromHtml(cells[1]);
    const title = textFromHtml(cells[2]);
    const sector = textFromHtml(cells[3]);
    const category = textFromHtml(cells[4]);
    if (!title || !company || !parsePublished(publishedText)) continue;

    const linkMatch = rowHtml.match(/href=["']([^"']*\/company-news\/[^"']+)["']/i)
      || cells[2].match(/href=["']([^"']+)["']/i);

    rows.push({
      publishedText,
      publishedAt: parsePublished(publishedText),
      company,
      title,
      sector,
      category,
      url: absoluteUrl(linkMatch?.[1]),
    });
  }
  return rows.slice(0, 50);
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
