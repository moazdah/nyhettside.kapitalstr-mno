'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { runAutopilotStepAction } from './actions';

const STAGE_LABELS = {
  discovery: 'Henter nye saker',
  scoring: 'Scorer radaren',
  selection: 'Velger toppsakene',
  research: 'Bygger kilde- og faktapakker',
  drafting: 'Skriver private utkast',
  done: 'Ferdig',
};

function queueSummary(state) {
  if (!state) return '';
  return `Scoring: ${state.scoring} · Utvalg: ${state.selectionPending ? 'venter' : (state.selected ?? 0) + ' valgt'} · Kilder/fakta: ${state.research} · Utkast: ${state.drafting}`;
}

export default function AutopilotControl() {
  const router = useRouter();
  const stopRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState('');
  const [message, setMessage] = useState('Klar. Autopiloten publiserer ingenting; ferdige saker havner privat i utkastskøen.');
  const [state, setState] = useState(null);
  const [processed, setProcessed] = useState(0);
  const [errors, setErrors] = useState([]);

  async function run() {
    if (running) return;

    stopRef.current = false;
    setRunning(true);
    setErrors([]);
    setProcessed(0);
    setStage('discovery');
    setMessage('Starter autopilot og henter nye radartreff …');

    let first = true;
    let activeRunId = null;
    let totalProcessed = 0;
    let stalled = 0;
    let loops = 0;
    const collectedErrors = [];

    try {
      while (!stopRef.current && loops < 160) {
        loops += 1;
        const result = await runAutopilotStepAction({ discovery: first, runId: activeRunId });
        first = false;
        if (result?.runId) activeRunId = Number(result.runId);

        if (!result?.ok) {
          const newErrors = Array.isArray(result?.errors) ? result.errors : ['Ukjent autopilot-feil'];
          collectedErrors.push(...newErrors);
          setErrors([...collectedErrors]);
          setMessage(`Autopiloten stoppet: ${newErrors[0] || 'ukjent feil'}`);
          break;
        }

        const currentState = result.state || null;
        const amount = Number(result.processed || 0);
        totalProcessed += amount;
        setProcessed(totalProcessed);
        setState(currentState);
        setStage(result.stage || '');

        if (Array.isArray(result.errors) && result.errors.length) {
          collectedErrors.push(...result.errors);
          setErrors([...collectedErrors]);
        }

        if (result.stage === 'discovery') {
          const inserted = Number(result.discovery?.inserted || 0);
          const seen = Number(result.discovery?.seen || 0);
          setMessage(`Discovery ferdig: ${seen} treff sjekket, ${inserted} nye lagret. Fortsetter automatisk …`);
          stalled = 0;
        } else if (result.stage === 'selection') {
          const selected = Array.isArray(result.selected) ? result.selected : [];
          const titles = selected.map((x) => '#' + x.rank + ' ' + x.title).join(' · ');
          setMessage(`Redaksjonelt utvalg ferdig: ${selected.length} unike saker valgt av maks 3.${titles ? ' ' + titles : ''}`);
          stalled = 0;
        } else {
          setMessage(`${STAGE_LABELS[result.stage] || 'Jobber'} · ${queueSummary(currentState)} · ${totalProcessed} arbeidssteg ferdig`);
          stalled = amount > 0 ? 0 : stalled + 1;
        }

        if (currentState?.done || result.stage === 'done') {
          setMessage(`Autopilot ferdig · ${totalProcessed} arbeidssteg behandlet · køen er tom.`);
          break;
        }

        if (stalled >= 3) {
          setMessage(`Autopiloten stoppet kontrollert fordi samme arbeid feilet flere ganger. ${queueSummary(currentState)}.`);
          break;
        }
      }

      if (stopRef.current) {
        setMessage(`Stoppet av deg. Alt som allerede er behandlet er lagret. ${queueSummary(state)}.`);
      } else if (loops >= 160) {
        setMessage('Autopiloten nådde sikkerhetsgrensen for denne kjøringen. Kjør den igjen for å fortsette resten.');
      }
    } catch (error) {
      const msg = error?.message || 'Ukjent feil';
      collectedErrors.push(msg);
      setErrors([...collectedErrors]);
      setMessage(`Autopiloten stoppet: ${msg}`);
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  function stop() {
    stopRef.current = true;
    setMessage('Stopper etter den deljobben som kjører nå …');
  }

  return (
    <div className="autopilotBox">
      <div className="autopilotTop">
        <div>
          <b>Autopilot · steg 1</b>
          <small>
            Ett klikk: discovery → scoring → duplikater samles til hendelser → opptil 3 toppsaker velges → kilde/faktapakke → private utkast.
          </small>
        </div>
        <div className="autopilotActions">
          <button
            type="button"
            className="adminLoadingButton"
            onClick={run}
            disabled={running}
            aria-busy={running}
          >
            {running ? <span className="adminSpinner" aria-hidden="true"/> : null}
            <span>{running ? (STAGE_LABELS[stage] || 'Autopilot jobber …') : 'Kjør hele autopiloten'}</span>
          </button>
          {running ? (
            <button type="button" className="secondary" onClick={stop}>Stopp</button>
          ) : null}
        </div>
      </div>

      <div className="autopilotStatus" aria-live="polite">
        <span>{message}</span>
        {state ? <b>{queueSummary(state)}</b> : null}
        {processed > 0 ? <small>{processed} arbeidssteg fullført i denne kjøringen.</small> : null}
        {errors.length ? <small className="autopilotWarning">{errors.length} del-feil logget · siste: {errors[errors.length - 1]}</small> : null}
      </div>

      {state && !state.done ? (
        <div className="autopilotProgress" aria-hidden="true">
          <span style={{ width: `${Math.max(4, Math.min(96, 100 - Math.min(96, state.totalRemaining)))}%` }}/>
        </div>
      ) : null}
    </div>
  );
}
