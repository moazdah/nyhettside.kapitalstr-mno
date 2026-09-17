export const SESSION_COOKIE = 'ks_admin_session';
const SESSION_MESSAGE = 'kapitalstrom-admin-v1';

const encoder = new TextEncoder();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function safeEqual(a = '', b = '') {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toHex(digest);
}

export async function passwordMatches(password) {
  const expected = process.env.ADMIN_PASSWORD_HASH;
  if (!expected) throw new Error('ADMIN_PASSWORD_HASH mangler i Vercel.');
  const actual = await sha256Hex(password);
  return safeEqual(actual, expected.trim().toLowerCase());
}

export async function expectedSessionValue() {
  const secret = process.env.ADMIN_PASSWORD_HASH;
  if (!secret) throw new Error('ADMIN_PASSWORD_HASH mangler i Vercel.');

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(SESSION_MESSAGE));
  return toHex(signature);
}
