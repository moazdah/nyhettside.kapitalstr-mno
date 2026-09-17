import Link from 'next/link';

const latest = [
  ['14:32', 'Oslo Børs snur i pluss'],
  ['14:17', 'Amerikanske renter faller etter inflasjonstall'],
  ['13:54', 'Kronen styrker seg mot dollar'],
  ['13:41', 'ECB-medlem kommenterer rentebanen'],
];

function Header() {
  return (
    <>
      <header className="siteHeader"><div className="headerInner"><Link href="/" className="logoWrap"><img src="/kapitalstrom-logo.png" alt="Kapitalstrøm" /></Link><nav className="mainNav"><a href="#">Markeder</a><a href="#">Økonomi</a><a href="#">Renter</a><a href="#">Selskaper</a><a href="#">Analyse</a><a href="#">Kalender</a></nav><div className="headerActions"><span className="search">⌕</span><a href="#">Redaksjon</a><a href="#">Logg inn</a><button>Abonner</button></div></div></header>
      <div className="ticker"><div className="tickerInner"><div className="tickerItem"><b>OSEBX</b><span>1 463,21</span><span className="up">+0,61 %</span></div><div className="tickerItem"><b>S&P 500</b><span>5 942,31</span><span className="up">+0,47 %</span></div><div className="tickerItem"><b>NASDAQ</b><span>19 412,80</span><span className="up">+0,62 %</span></div><div className="tickerItem"><b>EUR/NOK</b><span>11,7412</span><span className="down">−0,18 %</span></div><div className="tickerItem"><b>USD/NOK</b><span>10,6238</span><span className="down">−0,31 %</span></div><div className="tickerItem"><b>10Y USA</b><span>4,28 %</span><span className="down">−4 bp</span></div></div></div>
    </>
  );
}

export default function Article() {
  return (
    <><Header /><main className="articleShell"><article className="articleBody"><div className="breadcrumbs">Forside / Renter / Federal Reserve</div><div className="eyebrow">Renter</div><h1>Fed holder renten uendret – åpner for kutt senere i år</h1><p className="articleDek">Sentralbanken viser til fortsatt usikkerhet rundt inflasjonen, men signaliserer at pengepolitikken kan lettes dersom prisveksten fortsetter ned. Markedet priser nå inn to kutt før jul.</p><div className="articleMeta"><div><b>Av Kari Hansen</b><br/><span>Publisert 16. september 2026, 20:12 · Oppdatert 14:42</span></div><div><button>Del</button><button>Lagre</button></div></div><figure><div className="photoPlaceholder articlePhoto"><span>FOTO 16:9 — Jerome Powell, pressekonferanse</span></div><figcaption>Sentralbanksjef Jerome Powell under pressekonferansen etter rentemøtet. Foto: Kapitalstrøm</figcaption></figure><div className="prose"><p>Den amerikanske sentralbanken lot styringsrenten ligge i intervallet 5,25 til 5,50 prosent på onsdagens møte. Beslutningen var ventet, men ordlyden i uttalelsen var mykere enn på forrige møte.</p><p>I stedet for å beskrive prisveksten som «fortsatt høy», skriver komiteen nå at inflasjonen «har avtatt over de siste månedene». Endringen er liten på papiret, men den ble lagt merke til i rentemarkedet.</p><h2>Rentebanen flyttet seg</h2><p>Medlemmenes egne renteanslag viser nå et medianmedlem som ser to kutt i inneværende år. I juni var anslaget ett kutt.</p><blockquote>Vi trenger ikke å se inflasjonen på to prosent før vi begynner å lette, men vi må være overbevist om at vi er på vei dit.<footer>Jerome Powell, sentralbanksjef</footer></blockquote><p>For norske låntakere er koblingen indirekte, men reell. Faller amerikanske renter raskere enn de norske, svekkes normalt dollaren mot kronen.</p></div></article><aside className="articleSidebar"><div className="sectionKicker">Siste nytt <span className="live">● LIVE</span></div>{latest.map(([t,x])=><div className="sideNews" key={t}><span>{t}</span><b>{x}</b></div>)}<div className="sectionKicker relatedTitle">Relaterte saker</div><div className="relatedCard">Markedet priser inn to amerikanske rentekutt</div><div className="relatedCard">Hvorfor lange renter nekter å falle</div><div className="marketData"><div className="eyebrow">Markedsdata</div><p><span>USA 2 år</span><b className="down">3,92 % −9 bp</b></p><p><span>USA 10 år</span><b className="down">4,28 % −4 bp</b></p><p><span>USD/NOK</span><b className="down">10,6238</b></p><p><span>S&P 500</span><b className="up">+0,47 %</b></p></div></aside></main></>
  );
}
