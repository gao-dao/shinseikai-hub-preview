import { validateProxyRegistration } from './proxy-registration'

// Registration data only. A future HTTP layer must handle Turnstile separately;
// tokens must never become part of the RPC arguments or idempotency fingerprint.
export function validatePublicRegistration(body: unknown, idempotencyKey: unknown) {
  if (typeof idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    return { error: '申込キーの形式が不正です' }
  }
  const validation = validateProxyRegistration(body)
  if (!validation.data) return { error: validation.error }
  return { data: {
    ...validation.data,
    idempotency_key: idempotencyKey.toLowerCase(),
    schedule_ids: [...validation.data.schedule_ids].sort((a, b) => a - b),
  } }
}

export type PublicRegistrationResponse = {
  status: number
  body: { success: boolean; code: string; message: string }
}

const results = {
  REGISTERED: { success: true, status: 201, message: '申込を受け付けました' },
  GROUP_NOT_FOUND: { success: false, status: 404, message: '対象の講習会が見つかりません' },
  REGISTRATION_CLOSED: { success: false, status: 409, message: 'この講習会の申込受付は停止しています' },
  CLASS_NOT_FOUND: { success: false, status: 400, message: '選択したクラスが見つかりません' },
  CLASS_GROUP_MISMATCH: { success: false, status: 400, message: '同じ講習会のクラスだけ選択してください' },
  CLASS_CLOSED: { success: false, status: 409, message: '選択したクラスは申込を受け付けていません' },
  CAPACITY_EXCEEDED: { success: false, status: 409, message: '選択したクラスが満員のため申込できませんでした' },
} as const

export function publicRegistrationFailure(code: string, status: number, message: string): PublicRegistrationResponse {
  return { status, body: { success: false, code, message } }
}

// Never forward error messages, details, hints, applicant data or extra fields.
export function mapPublicRegistrationResult(data: unknown, error: unknown): PublicRegistrationResponse {
  if (error !== null && error !== undefined) {
    const code = typeof error === 'object' ? (error as { code?: unknown }).code : undefined
    if (code === 'PT409') return publicRegistrationFailure('IDEMPOTENCY_CONFLICT', 409, '申込キーと入力内容が一致しません。元の申込内容を確認してください')
    if (code === 'PT410') return publicRegistrationFailure('IDEMPOTENCY_EXPIRED', 410, '申込キーの確認期限が切れています。新しく申し込む前に受付状況をお問い合わせください')
    if (code === '22023') return publicRegistrationFailure('INVALID_INPUT', 400, '入力内容を確認してください')
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    const row = data as Record<string, unknown>
    if (Object.keys(row).length === 3 && Object.keys(row).every(key => ['success', 'code', 'http_status'].includes(key)) &&
        typeof row.code === 'string' && Object.hasOwn(results, row.code)) {
      const result = results[row.code as keyof typeof results]
      if (row.success === result.success && row.http_status === result.status) {
        return { status: result.status, body: { success: result.success, code: row.code, message: result.message } }
      }
    }
  }
  return publicRegistrationFailure('REGISTRATION_RESULT_UNKNOWN', 500, '申込結果を確認できませんでした。新しい申込キーで再送せず、同じ申込内容で結果を確認してください')
}
