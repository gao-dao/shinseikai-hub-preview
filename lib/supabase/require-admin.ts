import type { User } from '@supabase/supabase-js'
import { createClient } from './server'

type AdminAuthorizationFailure = {
  ok: false
  status: 401 | 403
  error: 'Unauthorized' | 'Forbidden'
}

type AdminAuthorizationSuccess = {
  ok: true
  user: User
}

export type AdminAuthorizationResult =
  | AdminAuthorizationFailure
  | AdminAuthorizationSuccess

/**
 * Verifies the user represented by the request cookies is an administrator.
 *
 * This intentionally uses the cookie-aware server client (anon key + session),
 * rather than a Service Role client. The Service Role key must only be used
 * after this authorization succeeds to perform an administrative operation.
 */
export async function requireAdmin(): Promise<AdminAuthorizationResult> {
  const supabase = await createClient()

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()

  if (userError || !user) {
    return { ok: false, status: 401, error: 'Unauthorized' }
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  // A missing profile (the shared member account) and any database error both
  // fail closed: only an explicit admin profile is authorized.
  if (profileError || profile?.role !== 'admin') {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  return { ok: true, user }
}
