import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { mapPublicRegistrationResult, publicRegistrationFailure, validatePublicRegistration, type PublicRegistrationResponse } from '@/lib/registrations/public-registration'

// This boundary exposes no general-purpose privileged client. The key itself
// still has service_role privileges; callers must add HTTP/Bot/rate-limit checks.
// No request object, cookies, or caller-supplied Authorization headers are accepted.
export async function submitPublicRegistration(body: unknown, idempotencyKey: unknown): Promise<PublicRegistrationResponse> {
  const validation = validatePublicRegistration(body, idempotencyKey)
  if (!validation.data) return publicRegistrationFailure('INVALID_INPUT', 400, validation.error)
  const input = validation.data
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const secret = process.env.SUPABASE_SECRET_KEY
    if (!url || !secret) return publicRegistrationFailure('SERVICE_UNAVAILABLE', 503, '現在、申込を受け付けられません。時間をおいてお試しください')
    const supabase = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (resource, init) => fetch(resource, { ...init, cache: 'no-store' }) },
    })
    // Exactly one RPC call. In particular, do not precheck mutable availability:
    // a saved replay must still succeed after closure or administrator cancellation.
    const { data, error } = await supabase.rpc('submit_registration_idempotent', {
      p_idempotency_key: input.idempotency_key,
      p_event_group_id: input.event_group_id,
      p_name: input.name,
      p_contact: input.contact,
      p_notes: input.notes,
      p_schedule_ids: input.schedule_ids,
    })
    return mapPublicRegistrationResult(data, error)
  } catch {
    // A disconnected response may follow a commit: never retry or generate a key.
    return publicRegistrationFailure('REGISTRATION_RESULT_UNKNOWN', 503, '申込結果を確認できませんでした。新しい申込キーで再送せず、同じ申込内容で結果を確認してください')
  }
}
