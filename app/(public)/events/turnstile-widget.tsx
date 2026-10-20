'use client'

import Script from 'next/script'
import { useEffect, useRef, useState } from 'react'

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string
  remove: (id: string) => void
}
declare global { interface Window { turnstile?: TurnstileApi } }

export default function TurnstileWidget({ onToken, generation }: { onToken: (token: string) => void; generation: number }) {
  const container = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  useEffect(() => {
    if (!ready || !sitekey || !container.current) return
    let active = true, id: string | undefined
    const clear = () => { if (active) { onToken(''); setError('操作確認をやり直してください。') } }
    // Subscribe after the commit. Ignore callbacks from a removed generation.
    void Promise.resolve().then(() => {
      if (!active || !container.current) return
      if (!window.turnstile) { clear(); return }
      try {
        onToken(''); setError('')
        id = window.turnstile.render(container.current, {
        sitekey, action: 'registration', retry: 'never', 'refresh-expired': 'manual', 'response-field': false,
        callback: (token: unknown) => { if (!active) return; if (typeof token === 'string' && /^[!-~]{1,2048}$/.test(token)) { setError(''); onToken(token) } else clear() },
        'expired-callback': clear, 'error-callback': clear, 'timeout-callback': clear,
        })
      } catch { clear() }
    })
    return () => { active = false; onToken(''); if (id !== undefined) { try { window.turnstile?.remove(id) } catch {} } }
  }, [ready, sitekey, generation, onToken])
  if (!sitekey) return <p role="alert">操作確認が未設定のため、現在は申込できません。</p>
  return <div aria-label="操作確認">
    <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" strategy="afterInteractive"
      onReady={() => setReady(true)} onError={() => { onToken(''); setError('操作確認を読み込めませんでした。') }} />
    <div ref={container} />
    {error && <p role="alert">{error}</p>}
  </div>
}
