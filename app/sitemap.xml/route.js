import { db } from '../../lib/db';
import { SITE_URL } from '../../lib/site';

export const dynamic = 'force-dynamic';

function xml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET() {
  const sql = db();
  const articles = await sql`
    SELECT slug, COALESCE(publisert_at, created_at) AS changed_at
    FROM articles
    WHERE status = 'live'
    ORDER BY COALESCE(publisert_at, created_at) DESC
    LIMIT 5000
  `;

  const urls = [
    `<url><loc>${xml(SITE_URL)}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    ...articles.map((article) => (
      `<url><loc>${xml(SITE_URL)}/artikkel/${xml(article.slug)}</loc><lastmod>${new Date(article.changed_at).toISOString()}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`
    )),
  ].join('');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=900' } }
  );
}
