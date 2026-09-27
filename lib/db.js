import { neon } from '@neondatabase/serverless';
import { ensureLiveUpdateSchema } from './live-update-schema';

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
  await ensureLiveUpdateSchema(sql);
  const [articles, feed, markets] = await Promise.all([
    sql`
      SELECT id, slug, tittel, undertittel, seksjon, forfatter,
             bilde_url, bilde_kreditt, image_alt, image_status, placement, priority_score,
             ai_score, pinned, pinned_pos, publisert_at, created_at, breaking_until, updated_at, breaking_event_id
      FROM articles
      WHERE status = 'live'
      -- Manual pins first; otherwise the shared desk score with age decay
      -- (lib/desk/priority.mjs currentRank). Active breaking stories get +15.
      ORDER BY CASE WHEN pinned AND COALESCE(pinned_source, 'manual') <> 'auto' THEN 1 ELSE 0 END DESC,
               CASE WHEN pinned AND COALESCE(pinned_source, 'manual') <> 'auto' THEN pinned_pos END ASC NULLS LAST,
               (COALESCE(priority_score, ai_score, 50)
                 - LEAST(100, EXTRACT(EPOCH FROM (now()-COALESCE(publisert_at,created_at)))/3600*2)
                 + CASE WHEN breaking_until > now() THEN 15 ELSE 0 END) DESC,
               publisert_at DESC NULLS LAST,
               created_at DESC
      LIMIT 12
    `,
    getLiveFeed(sql),
    sql`
      SELECT symbol, navn, verdi, endring_pct, oppdatert
      FROM markets
      ORDER BY CASE symbol
        WHEN 'OSEBX' THEN 1
        WHEN 'EQNR' THEN 2
        WHEN 'DNB' THEN 3
        WHEN 'KOG' THEN 4
        WHEN 'BTCUSD' THEN 5
        WHEN 'ETHUSD' THEN 6
        WHEN 'USDNOK' THEN 7
        WHEN 'EURNOK' THEN 8
        WHEN 'BRENT' THEN 9
        WHEN 'GOLD' THEN 10
        WHEN 'SP500' THEN 11
        WHEN 'NASDAQ' THEN 12
        WHEN 'NIKKEI' THEN 13
        WHEN 'NOKPOLICY' THEN 14
        WHEN 'GBPNOK' THEN 15
        WHEN 'SEKNOK' THEN 16
        ELSE 99
      END, navn
      LIMIT 18
    `,
  ]);
  return { articles, feed, markets };
}

export async function getArticleData(slug) {
  const sql = db();
  await ensureLiveUpdateSchema(sql);
  const [[article], feed, markets, related, sources] = await Promise.all([
    sql`
      SELECT id, slug, tittel, undertittel, brodtekst, seksjon, forfatter,
             bilde_url, bilde_kreditt, image_alt, image_license, image_source_url, image_status,
             publisert_at, created_at, updated_at, breaking_until, breaking_event_id, summary_points, kilde_url
      FROM articles
      WHERE slug = ${slug} AND status IN ('live', 'arkivert')
      LIMIT 1
    `,
    getLiveFeed(sql),
    sql`
      SELECT symbol, navn, verdi, endring_pct
      FROM markets
      ORDER BY CASE symbol
        WHEN 'OSEBX' THEN 1
        WHEN 'EQNR' THEN 2
        WHEN 'BTCUSD' THEN 3
        WHEN 'USDNOK' THEN 4
        WHEN 'EURNOK' THEN 5
        WHEN 'BRENT' THEN 6
        WHEN 'GOLD' THEN 7
        WHEN 'SP500' THEN 8
        WHEN 'NASDAQ' THEN 9
        WHEN 'NOKPOLICY' THEN 10
        ELSE 99
      END, navn
      LIMIT 18
    `,
    sql`
      SELECT slug, tittel, seksjon
      FROM articles
      WHERE status = 'live' AND slug <> ${slug}
      ORDER BY ai_score DESC NULLS LAST, publisert_at DESC NULLS LAST
      LIMIT 3
    `,
    sql`
      SELECT s.url, s.source_name, s.title, s.role, s.published_at
      FROM article_sources s JOIN articles a ON a.id = s.article_id
      WHERE a.slug = ${slug}
      ORDER BY CASE s.role WHEN 'primary' THEN 0 WHEN 'supporting' THEN 1 ELSE 2 END, s.added_at
      LIMIT 12
    `,
  ]);
  return { article, feed, markets, related, sources };
}


export async function getArticleMeta(slug) {
  const sql = db();
  const [article] = await sql`
    SELECT slug, tittel, undertittel, brodtekst, seksjon, forfatter,
           bilde_url, publisert_at, created_at, updated_at
    FROM articles
    WHERE slug = ${slug} AND status IN ('live', 'arkivert')
    LIMIT 1
  `;
  return article || null;
}

export async function getLiveFeed(sql = db()) {
  await ensureLiveUpdateSchema(sql);
  return sql`
      SELECT f.id,
             COALESCE(f.headline, f.tekst) AS headline,
             COALESCE(f.headline, f.tekst) AS tekst,
             f.summary, f.seksjon, f.tidspunkt, f.source_published_at,
             f.source_url, f.source_name, f.radar_item_id, f.article_id,
             f.priority, f.event_key,
             a.slug AS article_slug
      FROM feed f
      LEFT JOIN articles a ON a.id = f.article_id AND a.status = 'live'
      WHERE f.status = 'live'
        AND f.tidspunkt >= NOW() - interval '2 hours'
      ORDER BY f.tidspunkt DESC, f.priority DESC NULLS LAST, f.id DESC
      LIMIT 12
    `;
}

export async function getBreakingStory(sql=db()) {
 const [story]=await sql`SELECT slug,tittel,undertittel,publisert_at,updated_at,breaking_until
  FROM articles WHERE status='live' AND breaking_until>now() ORDER BY publisert_at DESC LIMIT 1`;
 return story||null;
}
