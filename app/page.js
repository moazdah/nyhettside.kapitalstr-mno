import Link from 'next/link';
import { getHomeData } from '../lib/db';
import { marketDelta, marketValue, relativeTime } from '../lib/format';
import { Header, LatestNews } from './components';

export const dynamic = 'force-dynamic';

function StoryMeta({ article }) {
  return <div className="muted">{article.forfatter || 'Kapitalstrøm'} · {relativeTime(article.publisert_at || article.created_at)}</div>;
}

export default async function Home() {
  const { articles, feed, markets } = await getHomeData();
  const lead = articles[0];
  const second = articles[1];
  const third = articles[2];
  const economy = articles.find((a) => a.seksjon === 'Økonomi') || articles[3];

  return (
    <>
      <Header markets={markets} />
      <main className="pageShell">
        <section className="heroGrid">
          <article className="leadStory">
            {lead ? <>
              <Link href={`/artikkel/${lead.slug}`}>
                <div className="eyebrow">{lead.seksjon}</div>
                <h1>{lead.tittel}</h1>
                {lead.undertittel && <p className="dek">{lead.undertittel}</p>}
              </Link>
              <div className="byline">Av {lead.forfatter || 'Kapitalstrøm'} <span>·</span> {relativeTime(lead.publisert_at || lead.created_at)}</div>
              <Link href={`/artikkel/${lead.slug}`} className="photoPlaceholder"><span>FOTO 16:9 — bildeplassholder</span></Link>
              <ul className="relatedLinks"><li>→ Analyse og bakgrunn kommer her</li><li>→ Relaterte saker kobles til senere</li></ul>
            </> : <p>Ingen publiserte saker ennå.</p>}
          </article>

          <div className="middleColumn">
            {second && <article>
              <div className="photoPlaceholder small"><span>FOTO 3:2 — bildeplassholder</span></div>
              <Link href={`/artikkel/${second.slug}`}><div className="eyebrow">{second.seksjon}</div><h2>{second.tittel}</h2></Link>
              {second.undertittel && <p>{second.undertittel}</p>}
              <StoryMeta article={second} />
            </article>}
            {third && <article className="secondStory">
              <Link href={`/artikkel/${third.slug}`}><div className="eyebrow">{third.seksjon}</div><h2>{third.tittel}</h2></Link>
              {third.undertittel && <p>{third.undertittel}</p>}
              <StoryMeta article={third} />
            </article>}
          </div>

          <LatestNews items={feed} />
        </section>

        <section className="marketSection">
          <div className="sectionTitleRow"><h2>Markedene nå</h2><a href="#">Alle markeder →</a></div>
          <div className="marketCards">
            {markets.slice(0,6).map((m) => {
              const delta = Number(m.endring_pct);
              return <div className="marketCard" key={m.symbol}><b>{m.navn}</b><strong>{marketValue(m.symbol, m.verdi)}</strong><span className={delta >= 0 ? 'up' : 'down'}>{marketDelta(delta)}</span></div>;
            })}
          </div>
        </section>

        <section className="splitSection">
          <div>
            <div className="sectionTitleRow topRule"><h2>Økonomi</h2><a href="#">Mer økonomi →</a></div>
            <div className="economyGrid">
              {economy && <article>
                <div className="photoPlaceholder"><span>FOTO 16:9 — bildeplassholder</span></div>
                <Link href={`/artikkel/${economy.slug}`}><div className="eyebrow">{economy.seksjon}</div><h2>{economy.tittel}</h2></Link>
                {economy.undertittel && <p>{economy.undertittel}</p>}
              </article>}
              <div className="storyList">
                {articles.filter((a) => a.id !== economy?.id && a.id !== lead?.id && a.id !== second?.id && a.id !== third?.id).slice(0,3).map((a) => (
                  <article key={a.id}><div className="eyebrow gray">{a.seksjon}</div><Link href={`/artikkel/${a.slug}`}><h3>{a.tittel}</h3></Link></article>
                ))}
              </div>
            </div>
          </div>
          <aside className="mostRead"><div className="sectionTitleRow topRule"><h2>Mest lest</h2></div>{articles.slice(0,4).map((a,i)=><div className="rank" key={a.id}><span>0{i+1}</span><Link href={`/artikkel/${a.slug}`}><b>{a.tittel}</b></Link></div>)}</aside>
        </section>
      </main>
      <footer><div className="footerInner"><img src="/kapitalstrom-logo.png" alt="Kapitalstrøm" /><p>Norsk finans- og økonomiredaksjon. Markeder, renter og makroøkonomi, hver dag.</p><div className="footerBottom"><span>© Kapitalstrøm 2026</span><span>Produksjonsprototype</span></div></div></footer>
    </>
  );
}
