type HistoryStatus = { hasRegistrationHistory: boolean; activeRegistrationCount: number }

export function scheduleDeletionBlockReason({ loading, error, status }: {
  loading: boolean
  error: string
  status?: HistoryStatus
}): string | null {
  if (loading) return '申込履歴を確認中のため削除できません。'
  if (error) return '申込履歴の取得に失敗したため削除できません。申込状況を再取得してください。'
  if (!status || typeof status.hasRegistrationHistory !== 'boolean' ||
      !Number.isSafeInteger(status.activeRegistrationCount) || status.activeRegistrationCount < 0) {
    return '申込履歴の有無が不明なため削除できません。申込状況を再取得してください。'
  }
  if (status.hasRegistrationHistory || status.activeRegistrationCount > 0) {
    return '取消済みを含む申込履歴があるため削除できません。'
  }
  return null
}

export async function deleteScheduleSafely({ id, getBlockReason, confirmDelete, remove, refresh }: {
  id: number
  getBlockReason: () => string | null
  confirmDelete: () => boolean
  remove: () => PromiseLike<{ data: { id: number }[] | null; error: { code?: string } | null }>
  refresh: () => Promise<void>
}): Promise<string | null> {
  const reason = getBlockReason()
  if (reason) return reason
  if (!confirmDelete()) return null
  // Recheck the available history information immediately before issuing DELETE.
  const latestReason = getBlockReason()
  if (latestReason) return latestReason
  try {
    const { data, error } = await remove()
    if (error) {
      return error.code === '23503'
        ? '申込履歴などの関連データがあるため削除できません。申込状況を再取得してください。'
        : '予定を削除できませんでした。権限や接続状況を確認してから再操作してください。'
    }
    // RLS or a concurrent deletion can yield zero affected rows without an error.
    if (data?.length !== 1 || data[0].id !== id) {
      return '予定の削除を確認できませんでした。権限や予定の状態を確認してください。'
    }
  } catch {
    return '予定の削除結果を確認できませんでした。接続状況と予定の状態を確認してください。'
  }
  try {
    await refresh()
  } catch {
    return '予定を削除しましたが、一覧を更新できませんでした。画面を再読み込みしてください。'
  }
  return null
}
