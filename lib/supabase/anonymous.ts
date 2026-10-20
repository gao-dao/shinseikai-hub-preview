import 'server-only'
import { createClient } from '@supabase/supabase-js'

// Public read-only requests must not inherit the visitor's cookies/session or
// elevated credentials. Only the publishable key is used here.
export function createAnonymousClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
    },
  )
}
