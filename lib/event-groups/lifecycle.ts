export type Lifecycle = { id: number; title?: string; is_cancelled: boolean; is_hidden: boolean; registration_open: boolean; state_version: number }
export function validLifecycle(v: unknown): v is Lifecycle {
  if (!v || typeof v !== 'object') return false
  const row = v as Lifecycle
  return Number.isSafeInteger(row.id) && row.id > 0 && typeof row.is_cancelled === 'boolean' && typeof row.is_hidden === 'boolean' && typeof row.registration_open === 'boolean' && Number.isSafeInteger(row.state_version) && row.state_version >= 0 && (!(row.is_cancelled || row.is_hidden) || !row.registration_open)
}
export function validStateCommand(value: unknown): value is { action: 'cancel' | 'hide' | 'show'; expected_state_version: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).length === 2 && Object.hasOwn(v, 'action') && Object.hasOwn(v, 'expected_state_version') && ['cancel', 'hide', 'show'].includes(v.action as string) && Number.isSafeInteger(v.expected_state_version) && (v.expected_state_version as number) >= 0
}
