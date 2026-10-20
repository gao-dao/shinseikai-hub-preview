export type RegistrationDetails = { name: string; contact: string; notes: string | null }

export function validateRegistrationDetails(body: unknown): { data: RegistrationDetails; error?: never } | { error: string; data?: never } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '入力内容が不正です' }
  const input = body as Record<string, unknown>
  if (Object.keys(input).some(key => !['name', 'contact', 'notes'].includes(key))) return { error: '指定できない項目が含まれています' }
  if (typeof input.name !== 'string' || Array.from(input.name.trim()).length < 1 || Array.from(input.name.trim()).length > 100) return { error: '氏名は1〜100文字で入力してください' }
  if (typeof input.contact !== 'string' || Array.from(input.contact.trim()).length < 1 || Array.from(input.contact.trim()).length > 254) return { error: '連絡先は1〜254文字で入力してください' }
  if (input.notes !== null && typeof input.notes !== 'string') return { error: '備考の形式が不正です' }
  if (typeof input.notes === 'string' && Array.from(input.notes).length > 2000) return { error: '備考は2000文字以内で入力してください' }
  return { data: { name: input.name.trim(), contact: input.contact.trim(), notes: typeof input.notes === 'string' ? input.notes.trim() || null : null } }
}
