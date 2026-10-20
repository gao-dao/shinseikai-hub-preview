export type RegistrationSettings = {
  event_group_id: number | null
  capacity: number | null
  registration_enabled: boolean
}

export type ScheduleHistory = { hasRegistrationHistory: boolean; activeRegistrationCount: number }

export function scheduleEditRestriction(next: RegistrationSettings, current: RegistrationSettings, history?: ScheduleHistory): string | null {
  if (!history || typeof history.hasRegistrationHistory !== 'boolean' ||
      !Number.isSafeInteger(history.activeRegistrationCount) || history.activeRegistrationCount < 0 ||
      (!history.hasRegistrationHistory && history.activeRegistrationCount > 0)) {
    return '申込状況を確認できないため更新できません。申込状況を再取得してください'
  }
  if (history.hasRegistrationHistory && next.event_group_id !== current.event_group_id) {
    return '取消済みを含む申込履歴があるため、講習会グループの変更・関連付け解除はできません'
  }
  if (history.activeRegistrationCount > 0 && (next.capacity === null || next.capacity < history.activeRegistrationCount)) {
    return '有効申込数未満の定員や未設定への変更はできません'
  }
  return null
}
