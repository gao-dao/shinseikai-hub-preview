export const registrationClassColumns = `id, title, date, start_time, end_time, event_group_id, capacity, registration_enabled,
  active_items:registration_items!registration_items_schedule_group_fkey(count)`

type ClassRow = { id: number; title: string; date: string; start_time: string | null; end_time: string | null; event_group_id: number | null; capacity: number | null; registration_enabled: boolean; active_items: { count: number }[] }

export function registrationClassAvailability(row: ClassRow) {
  const registeredCount = row.active_items?.[0]?.count
  if (!Number.isSafeInteger(registeredCount) || registeredCount < 0 || typeof row.registration_enabled !== 'boolean') throw new Error('Class information unavailable')
  const validCapacity = row.capacity !== null && Number.isInteger(row.capacity) && row.capacity > 0 && row.capacity <= 2147483647
  const remainingCapacity = validCapacity ? Math.max(row.capacity! - registeredCount, 0) : null
  const unavailableReason = !row.registration_enabled ? 'クラス受付が無効です' : !validCapacity ? '定員が未設定または不正です' : remainingCapacity === 0 ? '満員です' : null
  return { id: row.id, title: row.title, date: row.date, start_time: row.start_time, end_time: row.end_time, capacity: row.capacity, registeredCount, remainingCapacity, selectable: unavailableReason === null, unavailableReason }
}

export type RegistrationClass = ReturnType<typeof registrationClassAvailability>
