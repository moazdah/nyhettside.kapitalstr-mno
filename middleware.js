import { NextResponse } from 'next/server';
import { expectedSessionValue, safeEqual, SESSION_COOKIE } from './lib/auth';

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith('/redaksjon') || pathname.startsWith('/redaksjon/login')) {
    return NextResponse.next();
  }

  try {
    const session = request.cookies.get(SESSION_COOKIE)?.value || '';
    const expected = await expectedSessionValue();
    if (safeEqual(session, expected)) return NextResponse.next();
  } catch {
    // Manglende konfigurasjon behandles som ikke innlogget.
  }

  const url = new URL('/redaksjon/login', request.url);
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/redaksjon/:path*'],
};
