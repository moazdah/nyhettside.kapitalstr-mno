import { NextResponse } from 'next/server';
import { SESSION_COOKIE, validAdminSession } from './lib/auth';

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  if (pathname === '/redaksjon/login') return NextResponse.next();
  if (await validAdminSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const target=new URL('/redaksjon/login',request.url);
  target.searchParams.set('next',pathname+request.nextUrl.search);
  return NextResponse.redirect(target);
}

export const config = {
  matcher: ['/redaksjon/:path*'],
};
