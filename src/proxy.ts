import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// robots.txt and favicon must be readable WITHOUT a session — a crawler that
// gets redirected to /login never reads the disallow rule, which defeats the
// point of publishing one.
const PUBLIC_PATHS = [
  '/login',
  '/auth/callback',
  '/auth/signout',
  '/robots.txt',
  // The wall-display status board. It authenticates with a secret path segment
  // checked inside the route, not with a session — so it has to bypass the
  // session gate here or it would redirect to /login and be useless on a screen
  // nobody signs into. X-Robots-Tag and robots.txt keep it out of indexes.
  '/status',
  // Installability: a browser fetches these with no session while deciding
  // whether the app can go on a home screen, and a redirect to /login makes it
  // silently un-installable. Same trap robots.txt and the icons fell into.
  '/manifest.webmanifest',
  '/sw.js',
  '/offline.html',
  '/icon-192.png',
  '/icon-512.png',
  // Icons are fetched by the browser (and by iOS when saving to a home screen)
  // with no session. Gating them means a redirect instead of an image — the
  // same trap robots.txt and /api/sync both fell into.
  '/favicon.ico',
  '/icon.svg',
  '/icon',
  '/apple-icon',
  // Called by the sync container on a timer, with no browser session. It
  // authenticates with a shared secret of its own and refuses without one, so
  // gating it here only breaks it — which it silently did until a tick was
  // actually verified end to end.
  '/api/sync',
]

/**
 * Refreshes the Supabase session cookie on every request and gates the app.
 *
 * Next 16 renamed the `middleware` file convention to `proxy` — same
 * behaviour, new file and export name.
 *
 * Route protection also happens in each page via requireUser()/requireCapability() —
 * this is not an authorization boundary on its own, it just avoids rendering a
 * protected page only to redirect away from it.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    // everything except static assets and images
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
