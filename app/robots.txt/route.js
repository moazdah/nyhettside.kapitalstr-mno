import { SITE_URL } from '../../lib/site';

export const dynamic = 'force-dynamic';

export async function GET() {
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /redaksjon',
    '',
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    `Sitemap: ${SITE_URL}/news-sitemap.xml`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
}
