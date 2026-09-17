import { neon } from '@neondatabase/serverless';

let client;

export function db() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL mangler. Koble Neon til Vercel-prosjektet.');
  }
  if (!client) client = neon(process.env.DATABASE_URL);
  return client;
}

export async function getHomeData() {
  const sql = db();
  const [articles, feed, markets] = await Promise.all([
    sql`
      SELECT id, slug, tittel, undertittel, seksjon, forfatter,
             ai_score, pinned, pinned_pos, publisert_at, created_at
      FROM articles
      WHERE status = 'live'
      ORDER BY pinned DESC,
               pinned_pos ASC NULLS LAST,
               ai_score DESC NULLS LAST,
               publisert_at DESC NULLS LAST,
               created_at DESC
      LIMIT 12
    `,
    sql`
      SELECT id, tekst, seksjon, tidspunkt
      FROM feed
      WHERE status = 'live'
      ORDER BY tidspunkt DESC
      LIMIT 8
    `,
    sql`
      SELECT symbol, navn, verdi, endring_pct, oppdatert
      FROM markets
      ORDER BY CASE symbol
        WHEN 'NOKPOLICY' THEN 1
        WHEN 'USDNOK' THEN 2
        WHEN 'EURNOK' THEN 3
        WHEN 'GBPNOK' THEN 4
        WHEN 'SEKNOK' THEN 5
        WHEN 'DKKNOK' THEN 6
        WHEN 'CHFNOK' THEN 7
        ELSE 99
      END, navn
      LIMIT 10
    `,
  ]);
  return { articles, feed, markets };
}

export async function getArticleData(slug) {
  const sql = db();
  const [[article], feed, markets, related] = await Promise.all([
    sql`
      SELECT id, slug, tittel, undertittel, brodtekst, seksjon, forfatter,
             bilde_url, bilde_kreditt, publisert_at, created_at
      FROM articles
      WHERE slug = ${slug} AND status = 'live'
      LIMIT 1
    `,
    sql`
      SELECT id, tekst, seksjon, tidspunkt
      FROM feed
      WHERE status = 'live'
      ORDER BY tidspunkt DESC
      LIMIT 4
    `,
    sql`
      SELECT symbol, navn, verdi, endring_pct
      FROM markets
      ORDER BY CASE symbol
        WHEN 'NOKPOLICY' THEN 1
        WHEN 'USDNOK' THEN 2
        WHEN 'SP500' THEN 3
        WHEN 'OSEBX' THEN 4
        WHEN 'EURNOK' THEN 5
        ELSE 99
      END
      LIMIT 4
    `,
    sql`
      SELECT slug, tittel, seksjon
      FROM articles
      WHERE status = 'live' AND slug <> ${slug}
      ORDER BY ai_score DESC NULLS LAST, publisert_at DESC NULLS LAST
      LIMIT 3
    `,
  ]);
  return { article, feed, markets, related };
}
