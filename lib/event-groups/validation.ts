export type EventGroupOccurrence = {
  city: string | null
  start_date: string | null
  end_date: string | null
}

type Result<T> = { data: T; error?: never } | { error: string; data?: never }
const fields = ['city', 'start_date', 'end_date'] as const

function validDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

// Accept only occurrence fields. Callers must extract them from larger API bodies.
export function validateEventGroupOccurrence(body: unknown): Result<EventGroupOccurrence> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '開催情報の形式が不正です' }
  const input = body as Record<string, unknown>
  if (Object.keys(input).some(key => !fields.some(field => field === key))) return { error: '指定できない項目が含まれています' }
  const data: EventGroupOccurrence = { city: null, start_date: null, end_date: null }
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    if (value === null) continue
    if (typeof value !== 'string') return { error: '開催情報は文字列またはNULLで指定してください' }
    if (field === 'city') {
      const city = value.trim()
      if (Array.from(city).length > 100) return { error: '開催地は100文字以内で入力してください' }
      data.city = city || null
    } else {
      if (value === '') continue
      if (!validDate(value)) return { error: '開催日はYYYY-MM-DD形式の実在する日付で入力してください' }
      data[field] = value
    }
  }
  if ((data.start_date === null) !== (data.end_date === null)) return { error: '開始日と終了日は両方入力するか、両方未入力にしてください' }
  if (data.start_date !== null && data.end_date !== null && data.start_date > data.end_date) return { error: '開始日は終了日以前にしてください' }
  return { data }
}

// Omitted fields remain untouched; explicit null/empty input clears a field.
// Validate the resulting date pair, but return only supplied fields for UPDATE.
export function validateEventGroupOccurrenceUpdate(body: unknown, current: EventGroupOccurrence): Result<Partial<EventGroupOccurrence>> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '開催情報の形式が不正です' }
  const existing = validateEventGroupOccurrence(current)
  if (!existing.data) return { error: '現在の開催情報を確認できません' }
  const input = body as Record<string, unknown>
  const validated = validateEventGroupOccurrence({ ...existing.data, ...input })
  if (!validated.data) return { error: validated.error }
  const data: Partial<EventGroupOccurrence> = {}
  for (const field of fields) {
    if (Object.hasOwn(input, field)) data[field] = validated.data[field]
  }
  return { data }
}
