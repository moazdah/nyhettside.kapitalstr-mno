import Link from 'next/link';

const markets = [
  ['OSEBX', '1 463,21', '+0,61 %', 'up'],
  ['S&P 500', '5 942,31', '+0,47 %', 'up'],
  ['NASDAQ', '19 412,80', '+0,62 %', 'up'],
  ['EUR/NOK', '11,7412', '−0,18 %', 'down'],
  ['USD/NOK', '10,6238', '−0,31 %', 'down'],
  ['10Y USA', '4,28 %', '−4 bp', 'down'],
  ['Brent', '82,14', '+1,04 %', 'up'],
];

const latest = [
  ['14:32', 'Oslo Børs snur i pluss'],
  ['14:17', 'Amerikanske renter faller etter inflasjonstall'],
  ['13:54', 'Kronen styrker seg mot dollar'],
  ['13:41', 'ECB-medlem kommenterer rentebanen'],
  ['13:20', 'Brent-oljen over 82 dollar'],
  ['12:58', 'DNB nedjusterer anslaget for boligprisene'],
  ['12:35', 'Tysk industriproduksjon falt i august'],
  ['11:47', 'Yara varsler kutt i europeisk produksjon'],
];

function Header() {
  return (
    <>
      <header className="siteHeader">
        <div className="headerInner">
          <Link href="/" className="logoWrap"><img src="/kapitalstrom-logo.png" alt="Kapitalstrøm" /></Link>
          <nav className="mainNav">
            <a href="#">Markeder</a><a href="#">Økonomi</a><a href="#">Renter</a><a href="#">Selskaper</a><a href="#">Analyse</a><a href="#">Kalender</a>
          </nav>
          <div className="headerActions"><span className="search">⌕</span><a href="#">Redaksjon</a><a href="#">Logg inn</a><button>Abonner</button></div>
        </div>
      </header>
      <div className="ticker">
        <div className="tickerInner">
          {markets.map(([name, value, delta, dir]) => (
            <div className="tickerItem" key={name}><b>{name}</b><span>{value}</span><span className={dir}>{delta}</span></div>
          ))}
        </div>
      </div>
    </>
  );
}

function LatestNews() {
  return (
    <aside className="latest">
      <div className="sectionKicker">Siste nytt <span className="live">● LIVE</span></div>
      <ul>
        {latest.map(([t, title]) => <li key={t}><span>{t}</span><a href="#">{title}</a></li>)}
      </ul>
    </aside>
  );
}

export default function Home() {
  return (
    <>
      <Header />
      <main className="pageShell">
        <section className="heroGrid">
          <article className="leadStory">
            <Link href="/artikkel/fed">
              <div className="eyebrow">Renter</div>
              <h1>Fed holder renten uendret – åpner for kutt senere i år</h1>
              <p className="dek">Sentralbanken viser til fortsatt usikkerhet rundt inflasjonen, men signaliserer at pengepolitikken kan lettes dersom prisveksten fortsetter ned. Markedet priser nå inn to kutt før jul.</p>
            </Link>
            <div className="byline">Av Kari Hansen <span>·</span> 8 min siden</div>
            <Link href="/artikkel/fed" className="photoPlaceholder"><span>FOTO 16:9 — Fed-bygningen, Washington</span></Link>
            <ul className="relatedLinks"><li>→ Powells fem viktigste formuleringer, linje for linje</li><li>→ Så mye har rentebanen flyttet seg siden juni</li></ul>
          </article>

          <div className="middleColumn">
            <article>
              <div className="photoPlaceholder small"><span>FOTO 3:2 — Oslo Børs</span></div>
              <div className="eyebrow">Markeder</div>
              <h2>Oslo Børs snur i pluss etter svakere inflasjonstall</h2>
              <p>Sjømat og bank trekker opp. Equinor faller på lavere gasspris.</p>
              <div className="muted">Av Henrik Olsen · 24 min siden</div>
            </article>
            <article className="secondStory">
              <div className="eyebrow">Norges Bank</div>
              <h2>Dette kan avgjøre neste rentekutt fra Norges Bank</h2>
              <p>Kronekursen og lønnsoppgjøret trekker i hver sin retning før møtet 24. september.</p>
              <div className="muted">Av Ingrid Vollan · 1 time siden</div>
            </article>
          </div>

          <LatestNews />
        </section>

        <section className="marketSection">
          <div className="sectionTitleRow"><h2>Markedene nå</h2><a href="#">Alle markeder →</a></div>
          <div className="marketCards">
            {markets.slice(0,6).map(([name, value, delta, dir]) => <div className="marketCard" key={name}><b>{name}</b><strong>{value}</strong><span className={dir}>{delta}</span></div>)}
          </div>
        </section>

        <section className="splitSection">
          <div>
            <div className="sectionTitleRow topRule"><h2>Økonomi</h2><a href="#">Mer økonomi →</a></div>
            <div className="economyGrid">
              <article>
                <div className="photoPlaceholder"><span>FOTO 16:9 — Dagligvare, prisvekst</span></div>
                <div className="eyebrow">Inflasjon</div>
                <h2>Prisveksten faller til 2,8 prosent – lavest siden 2021</h2>
                <p>Matvarer og strøm trekker ned, men husleie og tjenester holder kjerneinflasjonen oppe.</p>
              </article>
              <div className="storyList">
                <article><div className="eyebrow gray">Arbeidsmarked</div><h3>Ledigheten stiger svakt i bygg og anlegg</h3></article>
                <article><div className="eyebrow gray">Boligmarked</div><h3>Boligprisene flatet ut i august etter fire måneder med oppgang</h3></article>
                <article><div className="eyebrow gray">Statsbudsjettet</div><h3>Oljepengebruken blir stridens kjerne i høst</h3></article>
              </div>
            </div>
          </div>
          <aside className="mostRead"><div className="sectionTitleRow topRule"><h2>Mest lest</h2></div>{['Kronen gjør sitt største hopp på tre måneder','Dette betyr Fed-beslutningen for markedet','Investorene flytter penger ut av teknologi','Norges Bank overrasket markedet'].map((x,i)=><div className="rank" key={x}><span>0{i+1}</span><b>{x}</b></div>)}</aside>
        </section>
      </main>
      <footer><div className="footerInner"><img src="/kapitalstrom-logo.png" alt="Kapitalstrøm" /><p>Norsk finans- og økonomiredaksjon. Markeder, renter og makroøkonomi, hver dag.</p><div className="footerBottom"><span>© Kapitalstrøm 2026</span><span>Ansvarlig redaktør: Henrik Olsen</span></div></div></footer>
    </>
  );
}
