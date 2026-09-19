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
    SELECT slug, tittel, COALESCE(publisert_at, created_at) AS published_at
    FROM articles
    WHERE status = 'live'
      AND COALESCE(publisert_at, created_at) >= NOW() - interval '2 days'
    ORDER BY COALESCE(publisert_at, created_at) DESC
    LIMIT 1000
  `;

  const entries = articles.map((article) => (
    `<url><loc>${xml(SITE_URL)}/artikkel/${xml(article.slug)}</loc><news:news><news:publication><news:name>Kapitalstrøm</news:name><news:language>no</news:language></news:publication><news:publication_date>${new Date(article.published_at).toISOString()}</news:publication_date><news:title>${xml(article.tittel)}</news:title></news:news></url>`
  )).join('');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${entries}</urlset>`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } }
  );
}
