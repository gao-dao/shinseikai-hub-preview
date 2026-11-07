import 'server-only'

const previewRef = 'ofyxyiumpjsfmycchbki'
export function isSingleEmail(value: string): boolean {
  if (value.length > 254 || value !== value.trim() || /[\s\x00-\x1f\x7f,;<>]/.test(value)) return false
  const parts = value.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  return local.length > 0 && local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) && domain.includes('.') &&
    domain.split('.').every(label => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
}
// Shared environment gate only. It does not guarantee delivery to an individual recipient.
export function isRegistrationEmailEnabled(env = process.env): boolean {
  return env.REGISTRATION_EMAIL_ENABLED === 'true' && env.REGISTRATION_EMAIL_PROJECT_REF === previewRef &&
    env.NEXT_PUBLIC_SUPABASE_URL === `https://${previewRef}.supabase.co` &&
    !!env.RESEND_API_KEY && !!env.RESEND_FROM_EMAIL && !!env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
    isSingleEmail(env.RESEND_FROM_EMAIL)
}
