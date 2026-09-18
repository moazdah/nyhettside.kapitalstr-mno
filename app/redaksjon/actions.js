'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { expectedSessionValue, safeEqual, SESSION_COOKIE } from '../../lib/auth';
import { approveDraft, archiveArticle, rejectDraft, setPinned } from '../../lib/admin-db';
import { syncNorgesBankFx } from '../../lib/sources/norges-bank';
import { syncNorgesBankPolicyRate } from '../../lib/sources/norges-bank-policy-rate';
import { syncEuronextOsloNews } from '../../lib/sources/euronext-oslo';
import { scorePendingRawItems } from '../../lib/ai/score-raw-items';
import { runNewsRadar } from '../../lib/radar/news-radar';
import { scorePendingRadarItems } from '../../lib/ai/score-radar-items';
import { buildFactPackForRadarItem } from '../../lib/research/fact-pack';

async function requireAdmin() {
  const store = await cookies();
  const actual = store.get(SESSION_COOKIE)?.value || '';
  const expected = await expectedSessionValue();
  if (!safeEqual(actual, expected)) redirect('/redaksjon/login');
}

export async function logoutAction() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect('/redaksjon/login');
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
    const result = await scorePendingRadarItems(30);
    revalidatePath('/redaksjon');
    return { ok: true, ...result };
  } catch (error) {
    console.error('Kapitalstrøm radar scoring failed:', error);
    redirect('/api/ai-status');
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
