export type NewSchedule = {
  title: string
  date: string
  start_time: string | null
  end_time: string | null
  location: string
  type: '稽古会' | '一般参加'
  event_group_id: number | null
  capacity: number | null
  registration_enabled: boolean
}

export function validateNewSchedule(body: unknown): { data: NewSchedule; error?: never } | { error: string; data?: never } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '入力内容が不正です' }
  const input = body as Record<string, unknown>
  const keys = ['title', 'date', 'start_time', 'end_time', 'location', 'type', 'event_group_id', 'capacity', 'registration_enabled']
  if (Object.keys(input).some(key => !keys.includes(key))) return { error: '指定できない項目が含まれています' }
  if (typeof input.title !== 'string' || !input.title.trim()) return { error: 'タイトルを入力してください' }
  if (typeof input.location !== 'string') return { error: '場所の形式が不正です' }
  if (typeof input.date !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.date) || input.date.startsWith('0000')) {
    return { error: '日付を正しく入力してください' }
  }
  const date = new Date(`${input.date}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.date) return { error: '日付を正しく入力してください' }
  const validTime = (value: unknown) => value == null || (typeof value === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/.test(value))
  if (!validTime(input.start_time) || !validTime(input.end_time)) return { error: '時刻を正しく入力してください' }
  if (input.type !== '稽古会' && input.type !== '一般参加') return { error: '種別が不正です' }
  const groupId = input.event_group_id ?? null
  const capacity = input.capacity ?? null
  const enabled = input.registration_enabled === undefined ? false : input.registration_enabled
  if (groupId !== null && (typeof groupId !== 'number' || !Number.isSafeInteger(groupId) || groupId <= 0)) return { error: '講習会グループが不正です' }
  if (capacity !== null && (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity <= 0 || capacity > 2147483647)) {
    return { error: '定員は1〜2147483647の整数で入力してください' }
  }
  if (typeof enabled !== 'boolean') return { error: 'クラス受付の形式が不正です' }
  if (enabled && (groupId === null || capacity === null)) return { error: 'クラス受付を有効にするには講習会グループと定員が必要です' }
  return { data: {
    title: input.title.trim(), date: input.date, location: input.location,
    start_time: (input.start_time as string | null | undefined) ?? null,
    end_time: (input.end_time as string | null | undefined) ?? null,
    type: input.type, event_group_id: groupId, capacity, registration_enabled: enabled,
  } }
}

// Form values stay strings until validated; never coerce decimals/exponents to integers.
export function parseRegistrationFields(group: string, capacity: string, enabled: boolean) {
  if ((group !== '' && !/^[1-9][0-9]*$/.test(group)) || (capacity !== '' && !/^[1-9][0-9]*$/.test(capacity))) {
    return { error: '講習会グループと定員は正の整数で指定してください' }
  }
  return { data: { event_group_id: group === '' ? null : Number(group), capacity: capacity === '' ? null : Number(capacity), registration_enabled: enabled } }
}
