import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import EventGroups from '../event-groups'

export const dynamic = 'force-dynamic'
export default async function Page() {
  const auth = await requireAdmin()
  if (!auth.ok) redirect(auth.status === 401 ? '/login' : '/videos')
  return <EventGroups createOnly />
}
