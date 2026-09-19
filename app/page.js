import Link from 'next/link';
import { getHomeData } from '../lib/db';
import { marketDelta, marketValue, relativeTime } from '../lib/format';
import { Header } from './components';
import LiveNewsRail from './LiveNewsRail';

export const dynamic = 'force-dynamic';

function StoryMeta({ article }) {
  return <div className="frontStoryMeta">{article.forfatter || 'Kapitalstrøm'} · {relativeTime(article.publisert_at || article.created_at)}</div>;
}

function StoryImage({ article, className = '' }) {
  if (article?.bilde_url) {
    return (
      <div className={`frontStoryImage ${className}`}>
        <img src={article.bilde_url} alt="" />
      </div>
    );
  }
  return (
    <div className={`frontStoryImage frontStoryImageFallback ${className}`}>
      <span>{article?.seksjon || 'Kapitalstrøm'}</span>
    </div>
  );
}

function StoryCard({ article, size = 'normal' }) {
  if (!article) return null;
  return (
    <article className={`frontStoryCard ${size}`}>
      <Link href={`/artikkel/${article.slug}`}>
        <StoryImage article={article} />
        <div className="frontStoryCopy">
          <div className="eyebrow">{article.seksjon}</div>
          <h2>{article.tittel}</h2>
          {article.undertittel ? <p>{article.undertittel}</p> : null}
          <StoryMeta article={article} />
        </div>
      </Link>
    </article>
  );
}

export default async function Home() {
  const { articles, feed, markets } = await getHomeData();
  const [lead, second, third, fourth, fifth, sixth, ...rest] = articles;

  return (
    <>
      <Header markets={markets} />
      <LiveNewsRail items={feed} />

      <main className="frontShell">
        <section className="frontHero">
          <article className="frontLeadCard">
            {lead ? (
              <Link href={`/artikkel/${lead.slug}`}>
                <StoryImage article={lead} className="lead" />
                <div className="frontLeadCopy">
                  <div className="eyebrow">{lead.seksjon}</div>
                  <h1>{lead.tittel}</h1>
                  {lead.undertittel ? <p className="frontLeadDek">{lead.undertittel}</p> : null}
                  <StoryMeta article={lead} />
                </div>
              </Link>
            ) : (
              <div className="frontEmpty">Ingen publiserte saker ennå.</div>
            )}
          </article>

          <div className="frontSideStack">
            <StoryCard article={second} size="side" />
            <StoryCard article={third} size="side" />
          </div>
        </section>

        <section className="frontFeatureGrid">
          <StoryCard article={fourth} size="feature" />
          <StoryCard article={fifth} size="feature" />
          <StoryCard article={sixth} size="feature" />
        </section>

        <section className="marketSection frontMarketSection">
          <div className="sectionTitleRow">
            <h2>Markedene nå</h2>
            <span className="sectionHint">Oppdatert markedsbilde</span>
          </div>
          <div className="marketCards">
            {markets.slice(0, 6).map((m) => {
              const delta = Number(m.endring_pct);
              return (
                <div className="marketCard" key={m.symbol}>
                  <b>{m.navn}</b>
                  <strong>{marketValue(m.symbol, m.verdi)}</strong>
                  <span className={delta >= 0 ? 'up' : 'down'}>{marketDelta(delta, m.symbol)}</span>
                </div>
              );
            })}
          </div>
        </section>

        {rest.length ? (
          <section className="frontMore">
            <div className="sectionTitleRow topRule">
              <h2>Flere saker</h2>
            </div>
            <div className="frontMoreGrid">
              {rest.map((article) => <StoryCard article={article} key={article.id} size="more" />)}
            </div>
          </section>
        ) : null}
      </main>

      <footer>
        <div className="footerInner">
          <img src="/kapitalstrom-logo.png" alt="Kapitalstrøm" />
          <p>Norsk finans- og økonomiredaksjon. Markeder, renter og makroøkonomi, hver dag.</p>
          <div className="footerBottom"><span>© Kapitalstrøm 2026</span><span>Kapitalstrøm</span></div>
        </div>
      </footer>
    </>
  );
}
