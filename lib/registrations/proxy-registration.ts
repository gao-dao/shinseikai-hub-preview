import { validateRegistrationDetails } from './details'

export function validateProxyRegistration(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '入力内容が不正です' }
  const input = body as Record<string, unknown>
  if (Object.keys(input).some(key => !['event_group_id', 'name', 'contact', 'notes', 'schedule_ids'].includes(key))) return { error: '指定できない項目が含まれています' }
  if (typeof input.event_group_id !== 'number' || !Number.isSafeInteger(input.event_group_id) || input.event_group_id <= 0) return { error: '講習会グループIDが不正です' }
  const ids = input.schedule_ids
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) return { error: '重複のないクラスIDを1〜50件指定してください' }
  const details = validateRegistrationDetails({ name: input.name, contact: input.contact, notes: input.notes === undefined ? null : input.notes })
  if (!details.data) return { error: details.error }
  return { data: { ...details.data, event_group_id: input.event_group_id, schedule_ids: ids as number[] } }
}
