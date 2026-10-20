'use client'

import { useLayoutEffect, useState } from 'react'

type Status = {
  id: number
  event_group_id: number | null
  event_groups: { id: number; title: string } | null
  capacity: number | null
  registration_enabled: boolean
  activeRegistrationCount: number
  hasRegistrationHistory: boolean
}
type Result = { schedules: Status[]; page: number; pageSize: number; total: number }

// Reload on entering the tab and whenever the existing schedule list refreshes.
export function useScheduleRegistrationStatuses(enabled: boolean, schedules: { id: number }[]) {
  const [statuses, setStatuses] = useState<Record<string, Status>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [loadedFor, setLoadedFor] = useState<{ schedules: { id: number }[]; reload: number } | null>(null)

  useLayoutEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    async function load() {
      setStatuses({})
      setLoading(true)
      setError('')
      try {
        const next: Record<string, Status> = {}
        let page = 1
        while (true) {
          const response = await fetch(`/api/admin/schedules?page=${page}`, { cache: 'no-store', signal: controller.signal })
          if (!response.ok) throw new Error(response.status === 401 ? 'ログインし直してください。' : response.status === 403 ? '管理者権限がありません。' : '予定・申込状況を取得できませんでした。')
          const data: Result = await response.json()
          if (!Array.isArray(data.schedules) || data.page !== page || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.pageSize) || data.pageSize <= 0) {
            throw new Error('予定・申込状況を確認できませんでした。')
          }
          for (const status of data.schedules) {
            if (!Number.isSafeInteger(status.activeRegistrationCount) || status.activeRegistrationCount < 0 || typeof status.hasRegistrationHistory !== 'boolean') {
              throw new Error('申込状況を確認できませんでした。')
            }
            next[String(status.id)] = status
          }
          if (page * data.pageSize >= data.total) break
          if (data.schedules.length === 0) throw new Error('予定・申込状況を確認できませんでした。')
          page += 1
        }
        if (!controller.signal.aborted) {
          setStatuses(next)
          setLoadedFor({ schedules, reload })
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '申込状況を確認できませんでした。')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [enabled, schedules, reload])

  // Invalidate previous results during the render that requests a reload, before
  // the effect starts. Previously loaded no-history data must not enable deletion.
  const current = enabled && loadedFor?.schedules === schedules && loadedFor?.reload === reload
  return { statuses: current ? statuses : {}, loading: loading || (enabled && !current && !error), error, refresh: () => setReload(value => value + 1) }
}

export function ScheduleRegistrationStatus({ status, loading }: { status?: Status; loading: boolean }) {
  if (loading) return <p className="list-sub" role="status">申込状況を読み込み中...</p>
  if (!status) return <p className="list-sub">講習会グループ・定員・受付状態・申込状況は確認できません。履歴の有無は不明です。</p>
  return (
    <div className="list-sub" style={{ overflowWrap: 'anywhere' }}>
      <p>講習会グループ：{status.event_groups?.title ?? (status.event_group_id === null ? '関連付けなし' : '確認できません')}</p>
      <p>定員：{status.capacity === null ? '未設定' : `${status.capacity}名`} ／ クラス受付：{status.registration_enabled ? '有効' : '無効'}</p>
      <p>有効申込数：{status.activeRegistrationCount}件 ／ 申込履歴（取消済みを含む）：{status.hasRegistrationHistory ? 'あり' : 'なし'}</p>
      {status.hasRegistrationHistory && <p>申込履歴があるため、講習会グループの変更・関連付け解除・予定の削除はDBの制約でできません。</p>}
    </div>
  )
}
