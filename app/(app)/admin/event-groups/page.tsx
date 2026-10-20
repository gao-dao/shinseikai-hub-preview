import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import EventGroups from './event-groups'

export const dynamic = 'force-dynamic'

export default async function EventGroupsPage() {
  const authorization = await requireAdmin()
  if (!authorization.ok) redirect(authorization.status === 401 ? '/login' : '/videos')
  return <EventGroups />
}
