import { redirect, notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { adminReturnHref } from '@/lib/event-groups/admin-index'
import OccurrenceEditor from '../../occurrence-editor'
export const dynamic = 'force-dynamic'
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireAdmin()
  if (!auth.ok) redirect(auth.status === 401 ? '/login' : '/videos')
  const { id } = await params
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) notFound()
  const returnTo = adminReturnHref((await searchParams)?.returnTo)
  return <OccurrenceEditor key={id} groupId={Number(id)} returnTo={returnTo} />
}
