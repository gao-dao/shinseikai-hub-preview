import type { Metadata } from 'next'
import EventsList from './events-list'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const metadata: Metadata = { title: '公開講習会 | 心勢会HUB' }

export default function EventsPage() {
  return <EventsList />
}
