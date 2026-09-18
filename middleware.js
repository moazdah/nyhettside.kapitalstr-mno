import { NextResponse } from 'next/server';

export function middleware(request) {
  const { pathname } = request.nextUrl;

  // TEMPORARY DEVELOPMENT MODE:
  // Redaksjonspanelet is intentionally open while the site is not live.
  if (pathname.startsWith('/redaksjon/login')) {
    return NextResponse.redirect(new URL('/redaksjon', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/redaksjon/:path*'],
};
