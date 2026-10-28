import Link from 'next/link'
import styles from './home.module.css'
export default function Home() {
  return <div className="hub-public-shell"><header className="hub-header"><Link href="/" className="hub-brand">心勢会HUB</Link><nav className="hub-nav" aria-label="公開メニュー"><Link href="/" aria-current="page">ホーム</Link><Link href="/events">開催案内</Link><Link href="/schedule">スケジュール</Link><Link href="/login">ログイン</Link></nav></header><main className={styles.page}>
    <div className={styles.inner}>
      <h1>心勢会HUB</h1>
      <nav aria-label="メインメニュー">
        <Link href="/events" className={styles.primary}>開催案内 →</Link>
        <Link href="/videos">動画ライブラリ → <span>会員向け・ログインが必要です</span></Link>
        <Link href="/login">ログイン →</Link>
      </nav>
    </div>
  </main></div>
}
