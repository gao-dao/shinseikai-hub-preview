import Link from 'next/link'
import styles from './home.module.css'

export default function Home() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>心勢会HUB</Link>
        <Link href="/login">ログイン →</Link>
      </header>
      <main className={styles.main}>
        <p className={styles.eyebrow}>心勢会の稽古会・講習会</p>
        <h1>次の稽古につながる、<br />開催案内。</h1>
        <p className={styles.intro}>開催日時や会場を確認して、ご都合に合う稽古会・講習会をお探しください。</p>
        <Link href="/schedule" className={styles.primary}>開催案内を見る <span aria-hidden="true">→</span></Link>
        <p className={styles.note}>ログインせずにご覧いただけます。</p>
        <section className={styles.secondary} aria-label="その他のご案内">
          <Link href="/events"><strong>Web申込</strong><span>現在受付中の講習会を確認する →</span></Link>
          <Link href="/videos"><strong>動画ライブラリ</strong><span>会員向けの動画を見る（ログインが必要です） →</span></Link>
        </section>
      </main>
      <footer className={styles.footer}>心勢会HUB</footer>
    </div>
  )
}
