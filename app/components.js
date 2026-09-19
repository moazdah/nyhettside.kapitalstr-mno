import Link from 'next/link';
import { clockTime } from '../lib/format';
import MarketTicker from './MarketTicker';

export function Header({ markets = [] }) {
  return (
    <>
      <MarketTicker markets={markets} />
      <header className="siteHeader">
        <div className="headerInner">
          <Link href="/" className="logoWrap"><img src="/kapitalstrom-logo.png" alt="Kapitalstrøm" /></Link>
          <nav className="mainNav">
            <a href="#">Markeder</a><a href="#">Økonomi</a><a href="#">Renter</a><a href="#">Selskaper</a><a href="#">Analyse</a><a href="#">Kalender</a>
          </nav>
          <div className="headerActions"><span className="search">⌕</span><Link href="/redaksjon">Redaksjon</Link><Link href="/redaksjon/login">Logg inn</Link><button>Abonner</button></div>
        </div>
      </header>
    </>
  );
}

export function LatestNews({ items = [], compact = false }) {
  if (compact) {
    return items.map((item) => (
      <div className="sideNews" key={item.id}>
        <span>{clockTime(item.tidspunkt)}</span><b>{item.tekst}</b>
      </div>
    ));
  }
  return (
    <aside className="latest">
      <div className="sectionKicker">Siste nytt <span className="live">● LIVE</span></div>
      <ul>
        {items.map((item) => (
          <li key={item.id}><span>{clockTime(item.tidspunkt)}</span><a href="#">{item.tekst}</a></li>
        ))}
      </ul>
    </aside>
  );
}
