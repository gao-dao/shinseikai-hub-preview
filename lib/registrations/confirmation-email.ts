import 'server-only'
import { loadConfirmationDetails, type ConfirmationDetails } from './confirmation-email-data'

const previewRef = 'ofyxyiumpjsfmycchbki'
const timeoutMs = 3000
export function isSingleEmail(value: string): boolean {
  if (value.length > 254 || value !== value.trim() || /[\s\x00-\x1f\x7f,;<>]/.test(value)) return false
  const parts = value.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  return local.length > 0 && local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) && domain.includes('.') &&
    domain.split('.').every(label => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
}
const line = (value: string) => value.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').trim()
export function confirmationText(details: ConfirmationDetails): string {
  return ['心勢会HUBへのお申込みを受け付けました。', '', `開催名：${line(details.title)}`, '', ...details.classes.flatMap(row => [
    `クラス：${line(row.title)}`,
    `日時：${row.date} ${row.start_time?.slice(0, 5) ?? '開始時刻未設定'}${row.end_time ? `～${row.end_time.slice(0, 5)}` : ''}（日本時間）`,
    `会場：${line(row.location)}`, '',
  ]), 'このメールは申込受付時点のご案内です。'].join('\n')
}

type Input = { event_group_id: number; schedule_ids: number[]; contact: string; idempotency_key: string }
// No durable delivery guarantee: a committed request replay deliberately never sends.
export async function sendRegistrationConfirmation(input: Input, fetcher: typeof fetch = fetch, env = process.env): Promise<void> {
  if (env.REGISTRATION_EMAIL_ENABLED !== 'true' || env.REGISTRATION_EMAIL_PROJECT_REF !== previewRef ||
      env.NEXT_PUBLIC_SUPABASE_URL !== `https://${previewRef}.supabase.co` ||
      !env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      !isSingleEmail(env.RESEND_FROM_EMAIL) || !isSingleEmail(input.contact) ||
      !Number.isSafeInteger(input.event_group_id) || input.event_group_id <= 0 ||
      !Array.isArray(input.schedule_ids) || input.schedule_ids.length < 1 || input.schedule_ids.length > 50 ||
      input.schedule_ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(input.schedule_ids).size !== input.schedule_ids.length ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.idempotency_key)) return
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('EMAIL_TIMEOUT')) }, timeoutMs)
  })
  try {
    await Promise.race([deadline, (async () => {
      const details = await loadConfirmationDetails(input.event_group_id, input.schedule_ids, env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, controller.signal, fetcher)
      if (controller.signal.aborted) return
      const response = await fetcher('https://api.resend.com/emails', {
        method: 'POST', signal: controller.signal, cache: 'no-store', credentials: 'omit',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
          'Idempotency-Key': `preview/registration-confirmation/${input.idempotency_key.toLowerCase()}` },
        body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [input.contact], subject: '心勢会HUB｜Web申込受付完了', text: confirmationText(details) }),
      })
      // Do not read/log provider response bodies, which may contain recipient information.
      if (!response.ok) throw new Error('EMAIL_NOT_ACCEPTED')
    })()])
  } catch { /* Best effort: no retries, PII logs, or changes to the registration result. */ }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort() }
}
