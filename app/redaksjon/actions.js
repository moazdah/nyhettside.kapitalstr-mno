'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { approveDraft, archiveArticle, rejectDraft, setPinned, updateDraftArticle, createManualDraft } from '../../lib/admin-db';
import { syncNorgesBankFx } from '../../lib/sources/norges-bank';
import { syncNorgesBankPolicyRate } from '../../lib/sources/norges-bank-policy-rate';
import { syncEuronextOsloNews } from '../../lib/sources/euronext-oslo';
import { scorePendingRawItems } from '../../lib/ai/score-raw-items';
import { runNewsRadar } from '../../lib/radar/news-radar';
import { prepareRadarCandidates } from '../../lib/radar/local-triage';
import { scorePendingRadarItems } from '../../lib/ai/score-radar-items';
import { buildFactPackForRadarItem } from '../../lib/research/fact-pack';
import { generateArticleDraftFromRadar } from '../../lib/ai/write-article';
import { runAutopilotStep } from '../../lib/autopilot/autopilot';
import { setAutomationEnabled, setAutoPublishEnabled } from '../../lib/autopilot/editorial-settings';

async function requireAdmin() {
  // TEMPORARY DEVELOPMENT MODE:
  // Authentication is intentionally disabled until the site is ready to go live.
  return true;
}

export async function logoutAction() {
  redirect('/redaksjon');
}

export async function setAutomationEnabledAction(enabled) {
  await requireAdmin();
  const settings = await setAutomationEnabled(enabled === true);
  revalidatePath('/redaksjon');
  return { ok: true, settings };
}

export async function setAutoPublishEnabledAction(enabled) {
  await requireAdmin();
  const settings = await setAutoPublishEnabled(enabled === true);
  revalidatePath('/redaksjon');
  return { ok: true, settings };
}

export async function approveAction(formData) {
  await requireAdmin();
  await approveDraft(Number(formData.get('id')));
  revalidatePath('/');
  revalidatePath('/redaksjon');
}

export async function rejectAction(formData) {
  await requireAdmin();
  await rejectDraft(Number(formData.get('id')));
  revalidatePath('/redaksjon');
}

export async function archiveAction(formData) {
  await requireAdmin();
  await archiveArticle(Number(formData.get('id')));
  revalidatePath('/');
  revalidatePath('/redaksjon');
}

export async function pinAction(formData) {
  await requireAdmin();
  const id = Number(formData.get('id'));
  const pinned = String(formData.get('pinned')) === 'true';
  await setPinned(id, pinned);
  revalidatePath('/');
  revalidatePath('/redaksjon');
}

export async function syncNorgesBankAction() {
  await requireAdmin();
  await Promise.all([syncNorgesBankFx(), syncNorgesBankPolicyRate()]);
  revalidatePath('/');
  revalidatePath('/redaksjon');
}

export async function syncPolicyRateAction() {
  await requireAdmin();
  await syncNorgesBankPolicyRate();
  revalidatePath('/');
  revalidatePath('/redaksjon');
}

export async function syncEuronextOsloAction() {
  await requireAdmin();
  await syncEuronextOsloNews();
  revalidatePath('/redaksjon');
}

export async function scoreRawItemsAction() {
  await requireAdmin();
  try {
    await scorePendingRawItems(20);
    revalidatePath('/redaksjon');
  } catch (error) {
    console.error('Kapitalstrøm AI-scoring failed:', error);
    redirect('/api/ai-status');
  }
}

export async function runNewsRadarAction() {
  await requireAdmin();
  try {
    const result = await runNewsRadar();
    revalidatePath('/redaksjon');
    return { ok: true, ...result };
  } catch (error) {
    console.error('Kapitalstrøm news radar failed:', error);
    throw error;
  }
}

export async function scoreRadarItemsAction() {
  await requireAdmin();
  try {
    const triage = await prepareRadarCandidates();
    const result = await scorePendingRadarItems(30);
    revalidatePath('/redaksjon');
    return { ok: true, triage, ...result };
  } catch (error) {
    console.error('Kapitalstrøm radar scoring failed:', error);
    return {
      ok: false,
      error: error?.message || 'Ukjent feil under radarscoring.',
      requested: 0,
      scored: 0,
      errors: [error?.message || 'Ukjent feil'],
    };
  }
}

export async function buildFactPackAction(formData) {
  await requireAdmin();
  const id = Number(formData.get('id'));
  if (!Number.isFinite(id)) throw new Error('Ugyldig radartreff.');
  const result = await buildFactPackForRadarItem(id);
  revalidatePath('/redaksjon');
  return { ok: true, ...result };
}

export async function generateArticleDraftAction(formData) {
  await requireAdmin();
  const id = Number(formData.get('id'));
  if (!Number.isFinite(id)) throw new Error('Ugyldig radartreff.');
  const result = await generateArticleDraftFromRadar(id);
  revalidatePath('/redaksjon');
  return result;
}

export async function approveFromDraftAction(formData) {
  await requireAdmin();
  await approveDraft(Number(formData.get('id')));
  revalidatePath('/');
  revalidatePath('/redaksjon');
  redirect('/redaksjon?tab=publisert');
}

export async function rejectFromDraftAction(formData) {
  await requireAdmin();
  await rejectDraft(Number(formData.get('id')));
  revalidatePath('/redaksjon');
  redirect('/redaksjon?tab=ko');
}


export async function saveDraftEditAction(formData) {
  await requireAdmin();
  const id = Number(formData.get('id'));
  if (!Number.isFinite(id)) throw new Error('Ugyldig utkast.');

  await updateDraftArticle(id, {
    tittel: formData.get('tittel'),
    undertittel: formData.get('undertittel'),
    brodtekst: formData.get('brodtekst'),
    seksjon: formData.get('seksjon'),
    forfatter: formData.get('forfatter'),
    bilde_url: formData.get('bilde_url'),
    bilde_kreditt: formData.get('bilde_kreditt'),
  });

  revalidatePath('/redaksjon');
  revalidatePath(`/redaksjon/utkast/${id}`);
  redirect(`/redaksjon/utkast/${id}?saved=1`);
}

export async function regenerateDraftFromReviewAction(formData) {
  await requireAdmin();
  const radarId = Number(formData.get('radar_id'));
  if (!Number.isFinite(radarId)) throw new Error('Dette utkastet er ikke koblet til et radartreff.');

  const result = await generateArticleDraftFromRadar(radarId);
  revalidatePath('/redaksjon');
  if (!result?.articleId) throw new Error('Kunne ikke regenerere utkastet.');
  redirect(`/redaksjon/utkast/${result.articleId}?regenerated=1`);
}


export async function createManualDraftAction() {
  await requireAdmin();
  const article = await createManualDraft();
  revalidatePath('/redaksjon');
  redirect(`/redaksjon/utkast/${article.id}?created=1`);
}


export async function runAutopilotStepAction(options = {}) {
  await requireAdmin();
  try {
    return await runAutopilotStep({
      discovery: options?.discovery === true,
      runId: options?.runId ? Number(options.runId) : null,
    });
  } catch (error) {
    console.error('Kapitalstrøm autopilot failed:', error);
    return {
      ok: false,
      stage: 'error',
      processed: 0,
      requested: 0,
      errors: [error?.message || 'Ukjent autopilot-feil'],
      state: null,
    };
  }
}


export async function manualCreateStoryAction(id) {
  await requireAdmin();
  const radarId = Number(id);
  if (!Number.isFinite(radarId)) {
    return { ok: false, error: 'Ugyldig radartreff.' };
  }

  try {
    const pack = await buildFactPackForRadarItem(radarId, { manualOverride: true });
    revalidatePath('/redaksjon');

    if (pack.status !== 'ready' || pack.canWrite !== true) {
      return {
        ok: false,
        stage: 'fact-pack',
        error: pack.status === 'needs_source'
          ? 'Fant ikke et sterkt nok kildegrunnlag ennå.'
          : pack.status === 'needs_review'
            ? 'Faktapakken trenger redaksjonell kontroll før artikkelen kan skrives.'
            : 'Kildegrunnlaget er for tynt til å skrive en trygg artikkel akkurat nå.',
        pack,
      };
    }

    const article = await generateArticleDraftFromRadar(radarId);
    revalidatePath('/redaksjon');
    return { ok: true, stage: 'draft', ...article };
  } catch (error) {
    console.error('Kapitalstrøm manual story creation failed:', error);
    return {
      ok: false,
      stage: 'error',
      error: error?.message || 'Kunne ikke lage saken.',
    };
  }
}
