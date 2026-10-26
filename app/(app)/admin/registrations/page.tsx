import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import RegistrationList from './registration-list'
import RegistrationBrowser from './registration-browser'
import Link from 'next/link'
import styles from './registrations.module.css'

export const dynamic = 'force-dynamic'

export default async function RegistrationsPage(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const authorization = await requireAdmin()
  if (!authorization.ok) {
    redirect(authorization.status === 401 ? '/login' : '/videos')
  }

  const params = await props?.searchParams ?? {}
  const history = params.view === 'history'
  return <><nav className={styles.tabs} aria-label="申込者管理の表示切替">
    <Link href="/admin/registrations" aria-current={!history ? 'page' : undefined}>開催回別</Link>
    <Link href="/admin/registrations?view=history" aria-current={history ? 'page' : undefined}>申込順・全履歴</Link>
  </nav>{history ? <RegistrationList /> : <RegistrationBrowser />}</>
}
