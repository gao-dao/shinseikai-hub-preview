import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import RegistrationList from './registration-list'

export const dynamic = 'force-dynamic'

export default async function RegistrationsPage() {
  const authorization = await requireAdmin()
  if (!authorization.ok) {
    redirect(authorization.status === 401 ? '/login' : '/videos')
  }

  return <RegistrationList />
}
