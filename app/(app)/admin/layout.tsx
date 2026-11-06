import type { ReactNode } from 'react'
import './admin-actions.css'

// Styles only: retain each page's existing server-side authorization boundary.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return children
}
