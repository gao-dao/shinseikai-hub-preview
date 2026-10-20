export type PublicClass = {
  id: number
  title: string
  date: string
  start_time: string | null
  end_time: string | null
  capacity: number | null
  remainingCapacity: number | null
  canRegister: boolean
  status: string
}
type Schedule = Omit<PublicClass, 'remainingCapacity' | 'canRegister' | 'status'> & { registration_enabled: boolean }
type Availability = { capacity: number; registered_count: number; remaining_capacity: number; is_full: boolean }

export function publicClassAvailability(schedule: Schedule, availability?: Availability): PublicClass {
  const capacityValid = schedule.capacity !== null && Number.isInteger(schedule.capacity) && schedule.capacity > 0
  const known = capacityValid && availability?.capacity === schedule.capacity &&
    Number.isSafeInteger(availability.registered_count) && availability.registered_count >= 0 &&
    Number.isSafeInteger(availability.remaining_capacity) && availability.remaining_capacity === Math.max(schedule.capacity! - availability.registered_count, 0) &&
    typeof availability.is_full === 'boolean' && availability.is_full === (availability.registered_count >= schedule.capacity!)
  const remainingCapacity = known ? availability.remaining_capacity : null
  const status = !schedule.registration_enabled ? 'クラス受付停止中' : !capacityValid ? '定員未設定' : !known ? '残席確認不可' : remainingCapacity === 0 ? '満員' : '受付可能'
  // Whitelist public metadata; never forward raw database rows.
  return { id: schedule.id, title: schedule.title, date: schedule.date, start_time: schedule.start_time, end_time: schedule.end_time,
    capacity: schedule.capacity, remainingCapacity, canRegister: status === '受付可能', status }
}
