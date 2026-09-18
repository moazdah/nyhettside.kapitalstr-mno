'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { manualCreateStoryAction } from './actions';

export default function ManualStoryButton({ id }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState('');

  function handleClick() {
    setMessage('Finner kildegrunnlag og lager privat utkast …');
    startTransition(async () => {
      const result = await manualCreateStoryAction(id);
      if (result?.ok && result?.articleId) {
        setMessage('Utkast klart. Åpner saken …');
        router.push('/redaksjon/utkast/' + result.articleId);
        return;
      }
      setMessage(result?.error || 'Kunne ikke lage saken.');
      router.refresh();
    });
  }

  return (
    <div className="radarManualStory">
      <button
        type="button"
        className="secondary adminLoadingButton"
        onClick={handleClick}
        disabled={isPending}
        aria-busy={isPending}
      >
        {isPending ? <span className="adminSpinner" aria-hidden="true"/> : null}
        <span>{isPending ? 'Lager sak …' : 'Lag sak nå'}</span>
      </button>
      {message ? <small aria-live="polite">{message}</small> : null}
    </div>
  );
}
