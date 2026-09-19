'use client';

import { useEffect, useRef, useState } from 'react';
import { marketDelta, marketValue } from '../lib/format';

function MarketItem({ market }) {
  const delta = Number(market.endring_pct || 0);
  const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  return (
    <div className="marketTickerItem">
      <b>{market.navn}</b>
      <span>{marketValue(market.symbol, market.verdi)}</span>
      <strong className={cls}>{marketDelta(delta, market.symbol)}</strong>
    </div>
  );
}

export default function MarketTicker({ markets = [] }) {
  const viewport = useRef(null);
  const [paused, setPaused] = useState(false);
  const resumeTimer = useRef(null);

  useEffect(() => {
    const el = viewport.current;
    if (!el || markets.length < 2) return undefined;

    const timer = setInterval(() => {
      if (paused) return;
      const half = el.scrollWidth / 2;
      if (half <= el.clientWidth) return;
      el.scrollLeft += 1.15;
      if (el.scrollLeft >= half) el.scrollLeft -= half;
    }, 24);

    return () => clearInterval(timer);
  }, [paused, markets.length]);

  function pauseTemporarily() {
    setPaused(true);
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => setPaused(false), 4500);
  }

  if (!markets.length) return null;
  const repeated = [...markets, ...markets];

  return (
    <div className="marketTickerBar" aria-label="Markedsdata">
      <div
        className="marketTickerViewport"
        ref={viewport}
        onPointerDown={pauseTemporarily}
        onTouchStart={pauseTemporarily}
        onWheel={pauseTemporarily}
      >
        <div className="marketTickerTrack">
          {repeated.map((market, index) => (
            <MarketItem market={market} key={`${market.symbol}-${index}`} />
          ))}
        </div>
      </div>
    </div>
  );
}
