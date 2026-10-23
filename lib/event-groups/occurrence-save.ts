import { validateOccurrenceInput, type OccurrenceInput } from './occurrence-editor'
export type SaveAttempt = { key: string; input: OccurrenceInput }
export type SaveOutcome = { state: 'saved'; groupId: number } | { state: 'unknown' | 'rejected'; error: string }
export function createOccurrenceSaver(send: typeof fetch, makeKey: () => string, storage: { read(): string | null; write(value: string): void; clear(): void }) {
  let attempt: SaveAttempt | null = null, busy = false, saved: number | null = null, uncertain = false
  function restore(groupId: number | null) {
    const raw = storage.read()
    if (!raw) return null
    const value = JSON.parse(raw) as SaveAttempt
    if (!value || typeof value.key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.key) || !validateOccurrenceInput(value.input).data || value.input.group_id !== groupId) throw new Error('一時保存情報を確認できません。管理者へ連絡してください。')
    attempt = value; uncertain = true
    return value
  }
  async function save(input?: OccurrenceInput): Promise<SaveOutcome> {
    if (busy) return { state: 'unknown', error: '保存中です。しばらくお待ちください。' }
    if (saved !== null) return { state: 'saved', groupId: saved }
    if (!attempt) {
      const checked = validateOccurrenceInput(input)
      if (!checked.data) return { state: 'rejected', error: checked.error }
      let key: string
      try { key = makeKey(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) throw new Error() } catch { return { state: 'rejected', error: '安全な保存キーを作成できないため送信していません。' } }
      const next = { key, input: checked.data }
      // Persist the frozen key/body BEFORE transmitting, so refresh can safely recover.
      try { storage.write(JSON.stringify(next)) } catch { return { state: 'rejected', error: 'ブラウザの一時保存領域を利用できないため送信していません。設定を確認してください。' } }
      attempt = JSON.parse(JSON.stringify(next)) as SaveAttempt
    }
    busy = true
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000)
    try {
      const response = await send('/api/admin/occurrences', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key }, body: JSON.stringify(attempt.input), signal: controller.signal })
      if (response.status === 429) return { state: 'unknown', error: '操作が集中しています。しばらく待って同じ保存を再確認してください。' }
      const body = await response.json()
      if (response.ok && body.saved === true && Number.isSafeInteger(body.group_id) && body.group_id > 0) {
        saved = body.group_id; try { storage.clear() } catch { /* Keeping the same key is safe on recovery. */ }
        return { state: 'saved', groupId: body.group_id as number }
      }
      if (response.status >= 400 && response.status < 500 && !uncertain) {
        try { storage.clear() } catch { return { state: 'unknown', error: '一時保存情報を解除できません。同じ保存を再確認してください。' } }
        attempt = null
        return { state: 'rejected', error: response.status === 409 ? '他の管理者によって変更されました。最新情報を読み込み、内容を確認して編集し直してください。' : '保存できませんでした。入力内容・定員・権限を確認してください。' }
      }
      uncertain = true
      return { state: 'unknown', error: '保存結果を確認できません。同じ保存キー・内容で再確認してください。' }
    } catch {
      uncertain = true
      return { state: 'unknown', error: '保存結果を確認できません。同じ保存キー・内容で再確認してください。' }
    } finally { clearTimeout(timer); busy = false }
  }
  return { restore, save }
}
