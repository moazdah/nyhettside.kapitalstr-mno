'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buildFactPackAction } from './actions';

export default function FactPackButton({ id, currentStatus }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState('');

  function handleClick() {
    if (isPending) return;
    setMessage('Leter etter primærkilde og bygger faktapakke …');

    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set('id', String(id));
        const result = await buildFactPackAction(formData);

        if (result?.status === 'ready') {
          setMessage(`Ferdig · ${result.facts || 0} fakta · ${result.numbers || 0} tall · kvalitet ${result.confidence || 0}/100`);
        } else if (result?.status === 'needs_review') {
          setMessage(`Bygget, men trenger kontroll · kvalitet ${result.confidence || 0}/100`);
        } else if (result?.status === 'needs_source') {
          setMessage('Stoppet trygt: primærkilde må finnes før artikkelskriving.');
        } else if (result?.status === 'insufficient_source') {
          setMessage('Offisiell kilde funnet, men den er for tynn til et sikkert artikkelutkast.');
        } else {
          setMessage('Faktapakken er oppdatert.');
        }

        router.refresh();
      } catch (error) {
        console.error(error);
        setMessage('Kunne ikke bygge faktapakken. Ingen artikkel ble skrevet.');
        router.refresh();
      }
    });
  }

  const label = currentStatus === 'ready'
    ? 'Bygg på nytt'
    : currentStatus
      ? 'Prøv faktapakke igjen'
      : 'Bygg faktapakke';

  return (
    <div style={{ minWidth: 145 }}>
      <button type="button" className="secondary" onClick={handleClick} disabled={isPending} aria-busy={isPending}>
        {isPending ? 'Jobber …' : label}
      </button>
      {message ? <small aria-live="polite" style={{ display: 'block', marginTop: 6, maxWidth: 220 }}>{message}</small> : null}
    </div>
  );
}
