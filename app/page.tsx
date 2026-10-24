import Link from 'next/link'
import styles from './home.module.css'
export default function Home() {
  return <main className={styles.page}>
    <div className={styles.inner}>
      <h1>心勢会HUB</h1>
      <nav aria-label="メインメニュー">
        <Link href="/events" className={styles.primary}>開催案内 →</Link>
        <Link href="/videos">動画ライブラリ → <span>会員向け・ログインが必要です</span></Link>
        <Link href="/login">ログイン →</Link>
      </nav>
    </div>
  </main>
}
