import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getArticleData, getArticleMeta } from '../../../lib/db';
import { SITE_URL } from '../../../lib/site';
import { fullDate, marketDelta, marketValue } from '../../../lib/format';
import { Header } from '../../components';
import LiveNewsRail from '../../LiveNewsRail';
import ArticleProse from '../../ArticleProse';
import BreakingArticleStatus from '../../BreakingArticleStatus';

export const dynamic = 'force-dynamic';

function descriptionOf(article) {
  const raw = article?.undertittel || article?.brodtekst || '';
  return String(raw)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 190);
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const article = await getArticleMeta(slug);
  if (!article) return {};

  const description = descriptionOf(article);
  const canonical = `${SITE_URL}/artikkel/${article.slug}`;

  return {
    title: article.tittel,
    description,
    alternates: { canonical },
    openGraph: {
      type: 'article',
      url: canonical,
      title: article.tittel,
      description,
      publishedTime: new Date(article.publisert_at || article.created_at).toISOString(),
      section: article.seksjon || undefined,
      images: article.bilde_url ? [{ url: article.bilde_url }] : undefined,
    },
  };
}

export default async function ArticlePage({ params }) {
  const { slug } = await params;
  const { article, feed, markets, related } = await getArticleData(slug);
  if (!article) notFound();

  const canonical = `${SITE_URL}/artikkel/${article.slug}`;
  const published = new Date(article.publisert_at || article.created_at).toISOString();
  const newsArticle = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: article.tittel,
    description: descriptionOf(article),
    datePublished: published,
    dateModified: article.updated_at ? new Date(article.updated_at).toISOString() : published,
    mainEntityOfPage: canonical,
    articleSection: article.seksjon || undefined,
    author: [{
      '@type': 'Organization',
      name: article.forfatter || 'Kapitalstrøm',
    }],
    publisher: {
      '@type': 'Organization',
      name: 'Kapitalstrøm',
      url: SITE_URL,
    },
    image: article.bilde_url ? [article.bilde_url] : undefined,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(newsArticle).replace(/</g, '\\u003c') }}
      />
      <Header markets={markets} />
      <LiveNewsRail items={feed} />
      <main className="articleShell">
        <article className="articleBody">
          <div className="breadcrumbs"><Link href="/">Forside</Link> / {article.seksjon}</div>
          <div className="eyebrow">{article.seksjon}</div>
          {article.breaking_event_id && <BreakingArticleStatus until={article.breaking_until} />}
          <h1>{article.tittel}</h1>
          {article.undertittel && <p className="articleDek">{article.undertittel}</p>}
          <div className="articleMeta">
            <div><b>Av {article.forfatter || 'Kapitalstrøm'}</b><br/><span>Publisert {fullDate(article.publisert_at || article.created_at)}</span>{article.updated_at && new Date(article.updated_at)>new Date(article.publisert_at) && <><br/><span>Oppdatert {fullDate(article.updated_at)}</span></>}</div>
            <div><button>Del</button><button>Lagre</button></div>
          </div>
          {article.bilde_url && <figure>
            <img src={article.bilde_url} alt="" className="articlePhoto" style={{width:'100%',height:'auto',display:'block',objectFit:'cover'}} />
            {article.bilde_kreditt && <figcaption>{article.bilde_kreditt}</figcaption>}
          </figure>}
          {article.summary_points?.length>0 && <details className="articleSummary"><summary>Saken oppsummert</summary>
            <ul>{article.summary_points.map((point,i)=><li key={i}>{point}</li>)}</ul>
            <small>Automatisk oppsummering av de kildebekreftede opplysningene i saken.</small>
          </details>}
          <ArticleProse body={article.brodtekst}/>
        </article>
        <aside className="articleSidebar">
          <div className="sectionKicker relatedTitle">Relaterte saker</div>
          {related.map((a) => <Link className="relatedCard" href={`/artikkel/${a.slug}`} key={a.slug}>{a.tittel}</Link>)}
          <div className="marketData"><div className="eyebrow">Markedsdata</div>{markets.map((m) => { const delta = Number(m.endring_pct); return <p key={m.symbol}><span>{m.navn}</span><b className={delta >= 0 ? 'up' : 'down'}>{marketValue(m.symbol, m.verdi)} · {marketDelta(delta, m.symbol)}</b></p>; })}</div>
        </aside>
      </main>
    </>
  );
}
