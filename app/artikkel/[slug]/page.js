import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getArticleData } from '../../../lib/db';
import { fullDate, marketDelta, marketValue } from '../../../lib/format';
import { Header, LatestNews } from '../../components';

export const dynamic = 'force-dynamic';

export default async function ArticlePage({ params }) {
  const { slug } = await params;
  const { article, feed, markets, related } = await getArticleData(slug);
  if (!article) notFound();

  const paragraphs = String(article.brodtekst || '').split(/\n\s*\n/).filter(Boolean);

  return (
    <>
      <Header markets={markets} />
      <main className="articleShell">
        <article className="articleBody">
          <div className="breadcrumbs"><Link href="/">Forside</Link> / {article.seksjon}</div>
          <div className="eyebrow">{article.seksjon}</div>
          <h1>{article.tittel}</h1>
          {article.undertittel && <p className="articleDek">{article.undertittel}</p>}
          <div className="articleMeta">
            <div><b>Av {article.forfatter || 'Kapitalstrøm'}</b><br/><span>Publisert {fullDate(article.publisert_at || article.created_at)}</span></div>
            <div><button>Del</button><button>Lagre</button></div>
          </div>
          <figure><div className="photoPlaceholder articlePhoto"><span>FOTO 16:9 — bildeplassholder</span></div><figcaption>{article.bilde_kreditt || 'Bilde kobles til i neste fase.'}</figcaption></figure>
          <div className="prose">
            {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          </div>
        </article>
        <aside className="articleSidebar">
          <div className="sectionKicker">Siste nytt <span className="live">● LIVE</span></div>
          <LatestNews items={feed} compact />
          <div className="sectionKicker relatedTitle">Relaterte saker</div>
          {related.map((a) => <Link className="relatedCard" href={`/artikkel/${a.slug}`} key={a.slug}>{a.tittel}</Link>)}
          <div className="marketData"><div className="eyebrow">Markedsdata</div>{markets.map((m) => { const delta = Number(m.endring_pct); return <p key={m.symbol}><span>{m.navn}</span><b className={delta >= 0 ? 'up' : 'down'}>{marketValue(m.symbol, m.verdi)} · {marketDelta(delta)}</b></p>; })}</div>
        </aside>
      </main>
    </>
  );
}
