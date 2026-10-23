import { redirect, notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import EventGroups from '../event-groups'

export const dynamic = 'force-dynamic'
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if (!auth.ok) redirect(auth.status === 401 ? '/login' : '/videos')
  const { id } = await params
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound()
  return <EventGroups groupId={Number(id)} />
}
