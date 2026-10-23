import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Refresh the standard Supabase session before authenticated pages render.
// Authorization remains in requireAdmin / RLS, never in a submitted role.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) return response
  try {
    const pending = new Map<string, { name: string; value: string; options: CookieOptions }>()
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: values => {
          for (const cookie of values) {
            pending.set(cookie.name, cookie)
            request.cookies.set(cookie.name, cookie.value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of pending.values()) {
            response.cookies.set(name, value, { ...options, path: '/', domain: undefined, sameSite: 'lax', secure: request.nextUrl.protocol === 'https:' })
          }
        },
      },
    })
    await supabase.auth.getUser()
    response.headers.set('Cache-Control', 'private, no-store, max-age=0')
    return response
  } catch {
    // Do not emit a partially written session; downstream authorization fails closed.
    response = NextResponse.next({ request })
    response.headers.set('Cache-Control', 'private, no-store, max-age=0')
    return response
  }
}

export const config = {
  matcher: ['/admin/:path*', '/videos/:path*', '/schedule/:path*', '/update-password'],
}
