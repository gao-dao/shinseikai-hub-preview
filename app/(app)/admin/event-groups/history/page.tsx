import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { indexOptions, type IndexResult } from '@/lib/event-groups/admin-index'
import { loadAdminIndex } from '@/lib/event-groups/admin-index-server'
import AdminIndexView from '../admin-index-view'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export default async function HistoryPage(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireAdmin()
  if (!auth.ok) redirect(auth.status === 401 ? '/login' : '/videos')
  let options = indexOptions(true), result: IndexResult | null = null, error = ''
  try { options = indexOptions(true, await props?.searchParams); result = await loadAdminIndex(options) }
  catch { error = '開催記録を取得できませんでした。条件を確認し、再読み込みしてください。' }
  return <AdminIndexView options={options} result={result} error={error} />
}
