'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { runNewsRadarAction, scoreRadarItemsAction } from './actions';

export default function RadarActionControl({ mode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState('');

  const isRun = mode === 'run';
  const label = isRun ? 'Kjør radar nå' : 'Vurder nye treff';
  const pendingLabel = isRun ? 'Radaren jobber …' : 'AI vurderer …';

  function handleClick() {
    if (isPending) return;

    setMessage(isRun
      ? 'Henter, filtrerer og lagrer nye radartreff. Dette kan ta litt tid.'
      : 'DeepSeek vurderer radartreffene. Vent til jobben er ferdig.');

    startTransition(async () => {
      try {
        const result = isRun
          ? await runNewsRadarAction()
          : await scoreRadarItemsAction();

        if (isRun) {
          const seen = Number(result?.seen || 0);
          const inserted = Number(result?.inserted || 0);
          const globalSeen = Number(result?.globalSeen || 0);
          const globalInserted = Number(result?.globalInserted || 0);
          const errors = Array.isArray(result?.errors) ? result.errors : [];
          const warning = errors.length
            ? ` · ${errors.length} kildekall feilet: ${errors.slice(0, 3).join(' | ')}`
            : '';
          setMessage(`Ferdig. ${seen} treff sjekket, ${inserted} nye lagret · global indeks: ${globalSeen} treff / ${globalInserted} nye${warning}.`);
        } else {
          const requested = Number(result?.requested || 0);
          const scored = Number(result?.scored || 0);
          setMessage(`Ferdig. ${scored} av ${requested} treff ble vurdert.`);
        }

        router.refresh();
      } catch (error) {
        console.error(error);
        setMessage('Noe gikk galt under kjøringen. Siden er fortsatt trygg; prøv igjen eller sjekk status.');
        router.refresh();
      }
    });
  }

  return (
    <div style={{ minWidth: 170, textAlign: 'right' }}>
      <button type="button" className="adminLoadingButton" onClick={handleClick} disabled={isPending} aria-busy={isPending}>
        {isPending ? <><span className="adminSpinner" aria-hidden="true"/><span>{pendingLabel}</span></> : <span>{label}</span>}
      </button>
      {message ? (
        <small aria-live="polite" style={{ display: 'block', marginTop: 7, maxWidth: 240 }}>
          {message}
        </small>
      ) : null}
    </div>
  );
}
