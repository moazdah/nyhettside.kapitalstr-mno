'use client';

import Link from 'next/link';
import { useState } from 'react';

function time(value) {
  if (!value) return '';
  try {
    const date = new Date(value);
    const now = new Date();
    const dateKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Oslo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const clock = new Intl.DateTimeFormat('nb-NO', {
      timeZone: 'Europe/Oslo',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);

    const currentKey = dateKey.format(now);
    const itemKey = dateKey.format(date);
    if (itemKey === currentKey) return clock;

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    if (itemKey === dateKey.format(yesterday)) return `i går ${clock}`;

    const day = new Intl.DateTimeFormat('nb-NO', {
      timeZone: 'Europe/Oslo',
      day: 'numeric',
      month: 'short',
    }).format(date);
    return `${day} ${clock}`;
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
    return <Link href={`/artikkel/${item.article_slug}`} className="liveRailLink">Les saken →</Link>;
  }
  if (item.source_url) {
    return <a href={item.source_url} target="_blank" rel="noreferrer" className="liveRailLink">Kilde ↗</a>;
  }
  return null;
}

export default function LiveNewsRail({ items = [] }) {
  const [expanded, setExpanded] = useState(false);
  const [focusedId, setFocusedId] = useState(null);

  if (!items.length) return null;

  function openItem(id) {
    setFocusedId(id);
    setExpanded(true);
  }

  return (
    <section className={`liveRail ${expanded ? 'expanded' : ''}`} aria-label="Løpende nyhetsoppdateringer">
      <div className="liveRailCompact">
        <button
          type="button"
          className="liveRailPulse"
          aria-label={expanded ? 'Minimer nyhetsstrømmen' : 'Åpne nyhetsstrømmen'}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <PulseIcon />
        </button>

        <div className="liveRailScroller">
          {items.slice(0, 7).map((item) => (
            <button
              type="button"
              className="liveRailTeaser"
              key={item.id}
              onClick={() => openItem(item.id)}
            >
              <strong>{item.headline || item.tekst}</strong>
              <span>{time(item.tidspunkt)}{item.seksjon ? ` · ${item.seksjon}` : ''}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="liveRailToggle"
          aria-label={expanded ? 'Minimer nyhetsstrømmen' : 'Vis alle nyhetsoppdateringer'}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{expanded ? '⌃' : '⌄'}</span>
        </button>
      </div>

      {expanded ? (
        <div className="liveRailPanel">
          <div className="liveRailPanelInner">
            {items.slice(0, 12).map((item) => (
              <article
                className={`liveRailCard ${focusedId === item.id ? 'focused' : ''}`}
                key={item.id}
              >
                <div className="liveRailMeta">
                  <time>{time(item.tidspunkt)}</time>
                  {item.seksjon ? <span>{item.seksjon}</span> : null}
                </div>
                <h3>{item.headline || item.tekst}</h3>
                {item.summary ? <p>{item.summary}</p> : null}
                <Destination item={item} />
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
