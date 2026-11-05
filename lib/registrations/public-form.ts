import { validateProxyRegistration } from './proxy-registration'
import { mapPublicRegistrationResult } from './public-registration'
import type { PublicClass } from './public-availability'

export const publicAttemptStorageKey = 'shinseikai-public-registration-attempt-v1'
type Input = NonNullable<ReturnType<typeof validateProxyRegistration>['data']>
type FrozenInput = Readonly<Omit<Input, 'schedule_ids'>> & { readonly schedule_ids: readonly number[] }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
type Pending = { groupId: number; key: string }
type Marker = { version: 2; completedGroupIds: number[]; pending: Pending | null }
const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
const exactKeys = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key))
function readMarker(storage: Storage): Marker {
  const raw = storage.getItem(publicAttemptStorageKey)
  if (raw === null) return { version: 2, completedGroupIds: [], pending: null }
  const row = JSON.parse(raw)
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('INVALID_MARKER')
  // A legacy success has no attributable group. Retire only this exact known
  // shape; legacy pending/unknown records (including their keys) remain intact.
  if (row.version === 1 && row.phase === 'success' && exactKeys(row, ['version', 'phase'])) {
    storage.removeItem(publicAttemptStorageKey)
    if (storage.getItem(publicAttemptStorageKey) !== null) throw new Error('STORAGE_FAILED')
    return { version: 2, completedGroupIds: [], pending: null }
  }
  if (row.version !== 2 || !exactKeys(row, ['version', 'completedGroupIds', 'pending']) ||
      !Array.isArray(row.completedGroupIds) || !row.completedGroupIds.every(validId) ||
      new Set(row.completedGroupIds).size !== row.completedGroupIds.length ||
      (row.pending !== null && (typeof row.pending !== 'object' || Array.isArray(row.pending) ||
        !exactKeys(row.pending, ['groupId', 'key']) || !validId(row.pending.groupId) || !validKey(row.pending.key)))) throw new Error('INVALID_MARKER')
  return row as Marker
}
function writeMarker(storage: Storage, marker: Marker) {
  if (!marker.pending && marker.completedGroupIds.length === 0) {
    storage.removeItem(publicAttemptStorageKey)
    if (storage.getItem(publicAttemptStorageKey) !== null) throw new Error('STORAGE_FAILED')
  } else {
    const raw = JSON.stringify(marker)
    storage.setItem(publicAttemptStorageKey, raw)
    if (storage.getItem(publicAttemptStorageKey) !== raw) throw new Error('STORAGE_FAILED')
  }
}
export type SubmissionResult = { kind: 'success' | 'rejected' | 'unknown' | 'busy'; message: string; retryAfterSeconds?: number }
const unknownResult: SubmissionResult = { kind: 'unknown', message: '申込結果を確認できません。同じ内容・同じ申込キーで再確認してください。新しく申し込まず、解決しない場合は主催者へお問い合わせください。' }

// No applicant data or challenge token is persisted. Reloading an unresolved
// attempt blocks new submissions: the original payload cannot safely be rebuilt.
export class PublicRegistrationAttempt {
  phase: 'ready' | 'pending' | 'success' | 'blocked' = 'ready'
  payload: FrozenInput | null = null
  private key: string | null = null
  private sending = false
  constructor(private storage: Storage, private uuid: () => string, private groupId: number) {
    try {
      if (!validId(groupId)) throw new Error('INVALID_GROUP')
      const marker = readMarker(storage)
      this.phase = marker.pending ? 'blocked' : marker.completedGroupIds.includes(groupId) ? 'success' : 'ready'
    } catch { this.phase = 'blocked' }
  }
  prepare(body: unknown): boolean {
    if (this.phase === 'pending') return this.payload !== null
    if (this.phase !== 'ready') return false
    const validation = validateProxyRegistration(body)
    if (!validation.data || validation.data.event_group_id !== this.groupId) return false
    try {
      // Recheck storage to prevent a stale mounted form overwriting an unresolved request.
      const marker = readMarker(this.storage)
      if (marker.pending || marker.completedGroupIds.includes(this.groupId)) { this.phase = 'blocked'; return false }
      const key = this.uuid()
      if (!validKey(key)) return false
      writeMarker(this.storage, { ...marker, pending: { groupId: this.groupId, key } })
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
    try {
      const marker = readMarker(this.storage)
      if (marker.pending?.groupId !== this.groupId || marker.pending.key !== this.key) return unknownResult
    } catch { return unknownResult }
    this.sending = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetcher('/api/registrations', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': this.key },
        body: JSON.stringify({ ...this.payload, turnstile_token: token }),
        credentials: 'omit', cache: 'no-store', signal: controller.signal,
      })
      // Firewall responses may be HTML or empty. Never parse or display their body.
      // A previous attempt may already have committed: preserve the original intent.
      if (response.status === 429) {
        const retry = response.headers.get('Retry-After')
        const seconds = retry && /^[1-9][0-9]{0,4}$/.test(retry) ? Number(retry) : undefined
        return { kind: 'rejected', message: '申込操作が集中しています。時間をおいて同じ申込内容・同じ申込キーで再確認してください。',
          ...(seconds ? { retryAfterSeconds: seconds } : {}) }
      }
      const data: unknown = await response.json()
      if (!data || typeof data !== 'object' || Array.isArray(data)) return unknownResult
      const row = data as Record<string, unknown>
      const mapped = mapPublicRegistrationResult({ success: row.success, code: row.code, http_status: response.status }, null)
      if (response.ok && mapped.body.success && response.status === 201) {
        this.phase = 'success'
        // If this write fails, the old pending marker remains, safely blocking
        // after reload. The successful response is still shown in this page.
        try {
          const marker = readMarker(this.storage)
          if (marker.pending?.groupId === this.groupId && marker.pending.key === this.key) {
            writeMarker(this.storage, { version: 2, completedGroupIds: [...new Set([...marker.completedGroupIds, this.groupId])], pending: null })
          }
        } catch {}
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
      const marker = readMarker(this.storage)
      if (marker.pending || !marker.completedGroupIds.includes(this.groupId)) return false
      writeMarker(this.storage, { ...marker, completedGroupIds: marker.completedGroupIds.filter(id => id !== this.groupId) })
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
