import Link from 'next/link'
import { indexHref, indexLabels, type IndexOptions, type IndexResult } from '@/lib/event-groups/admin-index'
import styles from './admin-index.module.css'
export default function AdminIndexView({ options, result, error }: { options: IndexOptions; result: IndexResult | null; error: string }) {
  const list = (items: IndexResult['items']) => <ul className={styles.list}>{items.map(item => <li key={item.id}><Link className={styles.item} href={`/admin/event-groups/${item.id}`}>
    <strong>{item.title} →</strong>
    <span>開催期間：{item.start_date || '未設定'}{item.end_date !== item.start_date ? `〜${item.end_date || '未設定'}` : ''}</span>
    <span>地域：{item.city || '未設定'}</span>
    {options.history && <span>状態：{indexLabels(item).join('・')}</span>}
  </Link></li>)}</ul>
  return <main className={styles.page}>
    <header className={styles.header}><h1>{options.history ? '開催記録・履歴' : '開催回管理'}</h1>{!options.history && <Link className={styles.primary} href="/admin/event-groups/new">新規作成</Link>}</header>
    <nav className={styles.nav} aria-label="管理メニュー">
      <Link href={options.history ? '/admin/event-groups' : '/admin/event-groups/history'}>{options.history ? '開催回管理へ' : '開催記録・履歴 →'}</Link>
      <Link href="/admin/videos">動画管理</Link><Link href="/admin/passwords">パスワード管理</Link><Link href="/admin/registrations">申込一覧</Link>
    </nav>
    {options.history && <form className={styles.filters} action="/admin/event-groups/history" method="get">
      <label>開催名<input type="search" name="q" defaultValue={options.q} maxLength={100} /></label>
      <label>状態<select name="state" defaultValue={options.state}><option value="all">すべて</option><option value="ended">開催終了</option><option value="cancelled">開催中止</option><option value="hidden">非表示</option></select></label>
      <button type="submit">検索</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {result && <>
      <p>全{result.total}件・{result.page}ページ目{!options.history ? `（開催予定 ${result.upcoming}件・要確認 ${result.review}件）` : ''}</p>
      {options.history ? (result.items.length ? list(result.items) : <p>該当する開催記録はありません。</p>) : <>
        <section aria-label="開催予定"><h2>開催予定</h2>{list(result.items.filter(item => item.phase === 'upcoming'))}</section>
        {result.review > 0 && <section aria-label="要確認"><h2>要確認</h2><p>日付未設定、または開催期間とクラス日付に不整合があります。</p>{list(result.items.filter(item => item.phase === 'unknown'))}</section>}
        {!result.total && <p>開催予定はありません。</p>}
      </>}
      <nav className={styles.nav} aria-label="開催回のページ切替">
        {result.page > 1 && <Link href={indexHref(options,result.page-1)}>← 前へ</Link>}
        {result.page*result.pageSize < result.total && <Link href={indexHref(options,result.page+1)}>次へ →</Link>}
      </nav>
    </>}
  </main>
}
