'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';

function time(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('nb-NO', {
      timeZone: 'Europe/Oslo',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return '';
  }
}

function PulseIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="3.2" fill="currentColor" />
      <path d="M10.6 10.6a7.6 7.6 0 0 0 0 10.8M21.4 10.6a7.6 7.6 0 0 1 0 10.8" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      <path d="M6.4 6.4a13.6 13.6 0 0 0 0 19.2M25.6 6.4a13.6 13.6 0 0 1 0 19.2" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}

function Destination({ item }) {
  if (item.article_slug) {
    return <Link href={`/artikkel/${item.article_slug}`} className="liveRailLink" onClick={(event) => event.stopPropagation()}>Les saken →</Link>;
  }
  if (item.source_url) {
    return <a href={item.source_url} target="_blank" rel="noreferrer" className="liveRailLink" onClick={(event) => event.stopPropagation()}>Kilde ↗</a>;
  }
  return null;
}

export default function LiveNewsRail({ items = [] }) {
  const demoItems = [
    {
      id: 'demo-1',
      headline: 'Demo: Oslo Børs åpner opp etter sterke teknologitall',
      summary: 'Fiktiv demonstrasjonssak for å vise hvordan en fersk markedsoppdatering vil se ut i live-strømmen.',
      seksjon: 'DEMO · MARKEDER',
      tidspunkt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    },
    {
      id: 'demo-2',
      headline: 'Demo: Kronen styrker seg etter nye inflasjonstall',
      summary: 'Fiktiv demonstrasjonssak som viser hvordan en kort valutaoppdatering presenteres.',
      seksjon: 'DEMO · VALUTA',
      tidspunkt: new Date(Date.now() - 7 * 60 * 1000).toISOString(),
    },
    {
      id: 'demo-3',
      headline: 'Demo: Nordic Grid løfter utsiktene for året',
      summary: 'Fiktivt selskapsnytt for å demonstrere formatet for korte, løpende selskapsoppdateringer.',
      seksjon: 'DEMO · SELSKAPER',
      tidspunkt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    },
    {
      id: 'demo-4',
      headline: 'Demo: Brent-oljen stiger videre i ettermiddagshandelen',
      summary: 'Fiktiv råvareoppdatering laget kun for visuell testing av Kapitalstrøm.',
      seksjon: 'DEMO · RÅVARER',
      tidspunkt: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
    },
    {
      id: 'demo-5',
      headline: 'Demo: Amerikanske renter faller før nye makrotall',
      summary: 'Fiktiv renteoppdatering for å vise hvordan flere samtidige saker fordeles i strømmen.',
      seksjon: 'DEMO · RENTER',
      tidspunkt: new Date(Date.now() - 24 * 60 * 1000).toISOString(),
    },
    {
      id: 'demo-6',
      headline: 'Demo: Bitcoin passerer ny intradagstopp',
      summary: 'Fiktiv kryptosak som demonstrerer hvordan en kort markedsmelding vil se ut.',
      seksjon: 'DEMO · KRYPTO',
      tidspunkt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    },
  ];

  const displayItems = items.length ? items : demoItems;
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const scrollerRef = useRef(null);
  const dragRef = useRef({ active: false, startX: 0, startScroll: 0, moved: false });

  function pointerDown(event) {
    const el = scrollerRef.current;
    if (!el) return;
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startScroll: el.scrollLeft,
      moved: false,
    };
    setDragging(true);
    el.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event) {
    const el = scrollerRef.current;
    const drag = dragRef.current;
    if (!el || !drag.active) return;
    const delta = event.clientX - drag.startX;
    if (Math.abs(delta) > 4) drag.moved = true;
    el.scrollLeft = drag.startScroll - delta;
  }

  function pointerUp(event) {
    const el = scrollerRef.current;
    dragRef.current.active = false;
    setDragging(false);
    el?.releasePointerCapture?.(event.pointerId);
    setTimeout(() => {
      dragRef.current.moved = false;
    }, 0);
  }

  function toggleFromStory() {
    if (!dragRef.current.moved) setExpanded((value) => !value);
  }

  return (
    <section className={`liveRail liveRailDrawer ${expanded ? 'expanded' : 'collapsed'}`} aria-label="Løpende nyhetsoppdateringer">
      <div className="liveRailDrawerGrid">
        <button
          type="button"
          className="liveRailPulse"
          aria-label={expanded ? 'Minimer nyhetsstrømmen' : 'Åpne nyhetsstrømmen'}
          onClick={() => setExpanded((value) => !value)}
        >
          <PulseIcon />
        </button>

        <div
          className={`liveRailStoryViewport ${dragging ? 'dragging' : ''}`}
          ref={scrollerRef}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
        >
          <div className="liveRailStoryTrack">
            {displayItems.slice(0, 12).map((item) => (
              <article
                className="liveRailStory"
                key={item.id}
                onClick={toggleFromStory}
              >
                <div className="liveRailStoryHead">
                  <h3>{item.headline || item.tekst}</h3>
                  <div className="liveRailStoryMeta">
                    <time>{time(item.tidspunkt)}</time>
                    {item.seksjon ? <span>{item.seksjon}</span> : null}
                  </div>
                </div>

                <div className="liveRailStoryBody" aria-hidden={!expanded}>
                  {item.summary ? <p>{item.summary}</p> : null}
                  <Destination item={item} />
                </div>
              </article>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="liveRailDrawerToggle"
          aria-label={expanded ? 'Rull opp nyhetsstrømmen' : 'Rull ned nyhetsstrømmen'}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{expanded ? '⌃' : '⌄'}</span>
        </button>
      </div>
    </section>
  );
}
