'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { expectedSessionValue, safeEqual, SESSION_COOKIE } from '../../lib/auth';
import { approveDraft, archiveArticle, rejectDraft, setPinned } from '../../lib/admin-db';
import { syncNorgesBankFx } from '../../lib/sources/norges-bank';
import { syncNorgesBankPolicyRate } from '../../lib/sources/norges-bank-policy-rate';
import { syncEuronextOsloNews } from '../../lib/sources/euronext-oslo';

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
