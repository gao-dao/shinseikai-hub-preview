'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import RegistrationForm from './registration-form'

type Group = { id: number; title: string; description: string | null }

// This component only hosts a server-validated, explicitly selected occurrence.
export default function EventsList({ initialGroup }: { initialGroup: Group }) {
  const registrationStart = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!registrationStart.current) return
    registrationStart.current.focus({ preventScroll: true })
    registrationStart.current.scrollIntoView({ behavior: 'instant', block: 'start' })
  }, [initialGroup.id])

  return <main className="events-page">
    <style>{`
      .events-page { min-height: 100vh; background: #FAF7F0; color: #1E293B; padding: 28px 20px 60px; }
      .events-inner { max-width: 960px; margin: 0 auto; }
      .events-page h1 { font-size: 26px; color: #6B1F2B; margin: 20px 0 12px; }
      .events-page h2 { font-size: 21px; margin-bottom: 12px; overflow-wrap: anywhere; }
      .events-page h3 { font-size: 17px; margin-bottom: 8px; overflow-wrap: anywhere; }
      .events-page p { margin: 10px 0; line-height: 1.7; overflow-wrap: anywhere; }
      .events-page a { color: #6B1F2B; }
      .events-group { margin: 24px 0; padding: 22px; background: #fff; border: 1px solid #EDE8DF; border-radius: 14px; box-shadow: 0 4px 16px rgba(0,0,0,.04); }
      .events-registration input:not([type="checkbox"]), .events-registration textarea { display: block; width: 100%; padding: 10px; margin: 6px 0 16px; border: 1px solid #CBD5E1; border-radius: 6px; background: #fff; }
      .events-registration label, .events-registration span { display: block; }
      .events-registration fieldset { border: 1px solid #EDE8DF; padding: 12px; margin: 16px 0; }
      .events-registration dd { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0 14px; }
      .events-class { padding: 18px 0; border-top: 1px solid #EDE8DF; }
      .events-page button { min-height: 44px; padding: 10px 16px; border: 1px solid #6B1F2B; border-radius: 8px; color: #6B1F2B; background: #F7EEF0; cursor: pointer; font: inherit; white-space: normal; overflow-wrap: anywhere; }
      .events-page button.events-primary { background: #6B1F2B; color: #fff; font-weight: 700; }
      .events-page button.events-secondary { background: #fff; color: #475569; border-color: #CBD5E1; }
      .events-page :is(button, a, input, textarea):focus-visible { outline: 3px solid #6B1F2B; outline-offset: 3px; }
      .events-page a { display: inline-flex; align-items: center; min-height: 44px; text-underline-offset: 4px; }
      .events-navigation { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; }
      .events-form-actions { align-items: center; }
      .events-form-actions > .events-primary { min-width: 200px; }
      .events-form-close { margin-top: 16px; }
      .events-page button:disabled { opacity: .5; cursor: default; }
      .events-registration-start { scroll-margin-top: 24px; }
      .events-registration-start:focus-visible { outline: 2px solid #6B1F2B; outline-offset: 4px; }
      .events-actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 14px 0; }
      @media(max-width:640px) { .events-page { padding: 16px 12px 40px; } .events-group { padding: 16px; } .events-form-actions > button { width: 100%; } .events-form-actions > .events-primary { min-width: 0; } }
    `}</style>
    <div className="events-inner">
      <nav className="events-navigation" aria-label="公開メニュー"><Link href="/events">開催案内へ</Link><Link href="/schedule">スケジュールへ</Link></nav>
      <h1>Web申込</h1>
      <div className="events-registration-start" ref={registrationStart} tabIndex={-1} aria-label={`${initialGroup.title}の参加申込`}>
        <RegistrationForm key={initialGroup.id} group={initialGroup} />
      </div>
    </div>
  </main>
}
