import { validateProxyRegistration } from './proxy-registration'
import { mapPublicRegistrationResult } from './public-registration'
import type { PublicClass } from './public-availability'

export const publicAttemptStorageKey = 'shinseikai-public-registration-attempt-v1'
type Input = NonNullable<ReturnType<typeof validateProxyRegistration>['data']>
type FrozenInput = Readonly<Omit<Input, 'schedule_ids'>> & { readonly schedule_ids: readonly number[] }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
export type SubmissionResult = { kind: 'success' | 'rejected' | 'unknown' | 'busy'; message: string; retryAfterSeconds?: number }
const unknownResult: SubmissionResult = { kind: 'unknown', message: '申込結果を確認できません。同じ内容・同じ申込キーで再確認してください。新しく申し込まず、解決しない場合は主催者へお問い合わせください。' }

// No applicant data or challenge token is persisted. Reloading an unresolved
// attempt blocks new submissions: the original payload cannot safely be rebuilt.
export class PublicRegistrationAttempt {
  phase: 'ready' | 'pending' | 'success' | 'blocked' = 'ready'
  payload: FrozenInput | null = null
  private key: string | null = null
  private sending = false
  constructor(private storage: Storage, private uuid: () => string) {
    try {
      const stored = storage.getItem(publicAttemptStorageKey)
      if (stored !== null) {
        const marker = JSON.parse(stored)
        this.phase = marker?.version === 1 && marker.phase === 'success' ? 'success' : 'blocked'
      }
    } catch { this.phase = 'blocked' }
  }
  prepare(body: unknown): boolean {
    if (this.phase === 'pending') return this.payload !== null
    if (this.phase !== 'ready') return false
    const validation = validateProxyRegistration(body)
    if (!validation.data) return false
    try {
      const key = this.uuid()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return false
      const marker = JSON.stringify({ version: 1, phase: 'pending', key })
      this.storage.setItem(publicAttemptStorageKey, marker)
      if (this.storage.getItem(publicAttemptStorageKey) !== marker) return false
      const data = validation.data
      this.payload = Object.freeze({ ...data, schedule_ids: Object.freeze([...data.schedule_ids].sort((a, b) => a - b)) })
      this.key = key
      this.phase = 'pending'
      return true
    } catch { return false }
  }
  async submit(token: string, fetcher: typeof fetch): Promise<SubmissionResult> {
    if (this.sending) return { kind: 'busy', message: '送信中です' }
    if (this.phase !== 'pending' || !this.payload || !this.key || !/^[!-~]{1,2048}$/.test(token)) return { kind: 'rejected', message: '入力内容と操作確認を確認してください' }
    this.sending = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetcher('/api/registrations', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': this.key },
        body: JSON.stringify({ ...this.payload, turnstile_token: token }),
        credentials: 'omit', cache: 'no-store', signal: controller.signal,
      })
      const data: unknown = await response.json()
      if (!data || typeof data !== 'object' || Array.isArray(data)) return unknownResult
      const row = data as Record<string, unknown>
      const mapped = mapPublicRegistrationResult({ success: row.success, code: row.code, http_status: response.status }, null)
      if (response.ok && mapped.body.success && response.status === 201) {
        this.phase = 'success'
        // If this write fails, the old pending marker remains, safely blocking
        // after reload. The successful response is still shown in this page.
        try { this.storage.setItem(publicAttemptStorageKey, JSON.stringify({ version: 1, phase: 'success' })) } catch {}
        return { kind: 'success', message: mapped.body.message }
      }
      if (!mapped.body.success && mapped.status < 500) return { kind: 'rejected', message: mapped.body.message }
      const errors: Record<string, { status: number; message: string }> = {
        IDEMPOTENCY_CONFLICT: { status: 409, message: '申込内容と申込キーが一致しません。新しく申し込まず主催者へお問い合わせください。' },
        IDEMPOTENCY_EXPIRED: { status: 410, message: '確認期限を過ぎています。新しく申し込む前に主催者へ受付状況をお問い合わせください。' },
        RATE_LIMIT_EXCEEDED: { status: 429, message: '申込操作が集中しています。時間をおいて同じ申込を再確認してください。' },
        TURNSTILE_REJECTED: { status: 403, message: '操作確認に失敗しました。操作確認をやり直してください。' },
        TURNSTILE_INVALID_TOKEN: { status: 403, message: '操作確認の有効期限が切れました。操作確認をやり直してください。' },
        ORIGIN_REJECTED: { status: 403, message: 'このページからの申込を受け付けられません。主催者へお問い合わせください。' },
        INVALID_INPUT: { status: 400, message: '入力を受け付けられませんでした。新しく申し込まず主催者へお問い合わせください。' },
      }
      const known = typeof row.code === 'string' && Object.hasOwn(errors, row.code) ? errors[row.code] : undefined
      if (row.success === false && known?.status === response.status) {
        const retry = response.headers.get('Retry-After')
        const seconds = retry && /^[1-9][0-9]{0,4}$/.test(retry) ? Number(retry) : undefined
        return { kind: 'rejected', message: known.message, ...(seconds ? { retryAfterSeconds: seconds } : {}) }
      }
      return unknownResult
    } catch { return unknownResult }
    finally { clearTimeout(timer); this.sending = false }
  }
  startNew(): boolean {
    if (this.phase !== 'success' || this.sending) return false
    try {
      this.storage.removeItem(publicAttemptStorageKey)
      if (this.storage.getItem(publicAttemptStorageKey) !== null) return false
      this.payload = null; this.key = null; this.phase = 'ready'
      return true
    } catch { return false }
  }
}

export async function loadPublicRegistrationClasses(groupId: number, fetcher: typeof fetch, signal: AbortSignal): Promise<PublicClass[]> {
  const items: PublicClass[] = [], seen = new Set<number>()
  let total: number | undefined
  for (let page = 1; page <= 10000; page++) {
    const response = await fetcher(`/api/event-groups/${groupId}/classes?page=${page}`, { cache: 'no-store', credentials: 'omit', signal })
    if (!response.ok) throw new Error('CLASSES_UNAVAILABLE')
    const data = await response.json()
    if (!Array.isArray(data.schedules) || data.page !== page || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pageSize) || data.pageSize < 1 || (total !== undefined && total !== data.total)) throw new Error('CLASSES_UNAVAILABLE')
    total = data.total
    for (const row of data.schedules) {
      if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || seen.has(row.id) || typeof row.title !== 'string' || typeof row.date !== 'string' || typeof row.status !== 'string' || typeof row.canRegister !== 'boolean' ||
          (row.start_time !== null && typeof row.start_time !== 'string') || (row.end_time !== null && typeof row.end_time !== 'string') ||
          (row.capacity !== null && (!Number.isSafeInteger(row.capacity) || row.capacity <= 0)) ||
          (row.remainingCapacity !== null && (!Number.isSafeInteger(row.remainingCapacity) || row.remainingCapacity < 0)) ||
          (row.canRegister && (row.capacity === null || row.remainingCapacity === null || row.remainingCapacity <= 0 || row.remainingCapacity > row.capacity))) throw new Error('CLASSES_UNAVAILABLE')
      seen.add(row.id)
      items.push({ id: row.id, title: row.title, date: row.date, start_time: row.start_time, end_time: row.end_time, capacity: row.capacity, remainingCapacity: row.remainingCapacity, canRegister: row.canRegister, status: row.status })
    }
    if (items.length > data.total) throw new Error('CLASSES_UNAVAILABLE')
    if (page * data.pageSize >= data.total) {
      if (items.length !== data.total) throw new Error('CLASSES_UNAVAILABLE')
      return items
    }
    if (data.schedules.length === 0) throw new Error('CLASSES_UNAVAILABLE')
  }
  throw new Error('CLASSES_UNAVAILABLE')
}
