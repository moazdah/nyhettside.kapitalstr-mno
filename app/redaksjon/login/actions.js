'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { expectedSessionValue, passwordMatches, SESSION_COOKIE } from '../../../lib/auth';

export async function loginAction(formData) {
  const password = String(formData.get('password') || '');
  const next = String(formData.get('next') || '/redaksjon');

  let ok = false;
  try {
    ok = await passwordMatches(password);
  } catch {
    redirect('/redaksjon/login?config=1');
  }

  if (!ok) redirect(`/redaksjon/login?error=1&next=${encodeURIComponent(next)}`);

  const store = await cookies();
  store.set(SESSION_COOKIE, await expectedSessionValue(), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  redirect(next.startsWith('/redaksjon') ? next : '/redaksjon');
}
