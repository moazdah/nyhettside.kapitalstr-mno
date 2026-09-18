'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { generateArticleDraftAction } from './actions';

export default function ArticleDraftButton({ id }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState('');

  function handleClick() {
    if (isPending) return;
    setMessage('Skriver utkast og faktasjekker det mot faktapakken …');

    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set('id', String(id));
        const result = await generateArticleDraftAction(formData);

        if (result?.ok && result?.articleId) {
          const checkText = result.tallValidert
            ? 'tallkontroll bestått'
            : 'lagret med et kontrollpunkt';
          setMessage(result.status === 'existing'
            ? 'Utkastet finnes allerede. Går til utkastskøen …'
            : `Utkast lagret · ${checkText}. Går til utkastskøen …`);
          router.push('/redaksjon?tab=ko');
          return;
        }

        setMessage(result?.reason || 'Utkastet ble blokkert av faktakontrollen.');
        router.refresh();
      } catch (error) {
        console.error(error);
        setMessage('Artikkelmotoren stoppet. Ingen artikkel ble publisert.');
        router.refresh();
      }
    });
  }

  return (
    <div style={{ minWidth: 150 }}>
      <button type="button" onClick={handleClick} disabled={isPending} aria-busy={isPending}>
        {isPending ? 'Skriver og sjekker …' : 'Lag artikkelutkast'}
      </button>
      {message ? <small aria-live="polite" style={{ display: 'block', marginTop: 6, maxWidth: 240 }}>{message}</small> : null}
    </div>
  );
}
