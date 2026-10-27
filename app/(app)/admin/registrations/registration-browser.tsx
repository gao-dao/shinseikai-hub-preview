'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ClassResult, GroupResult, ItemResult, Parent } from '@/lib/registrations/admin-browser';
import { indexLabels } from '@/lib/event-groups/admin-index';
import RegistrationDetailsForm from './registration-details-form';
import AddRegistrationItems from './add-registration-items';
import CancelRegistrationItem from './cancel-registration-item';
import styles from './registrations.module.css';
function endpoint(resource: string, values: Record<string, string | number>) { return `/api/admin/registration-browser?${new URLSearchParams({ resource, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])) })}`; }
function useRead<T>(url: string | null, revision = 0) {
    const key = `${url}|${revision}`;
    const [loaded, setLoaded] = useState<{
        key: string;
        data: T | null;
        error: string;
    } | null>(null);
    useEffect(() => {
        if (!url)
            return;
        const controller = new AbortController();
        void (async () => {
            try {
                const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
                if (!response.ok)
                    throw new Error(response.status === 401 ? 'ログインし直してください。' : response.status === 403 ? '管理者権限がありません。' : '一覧を完全に取得できませんでした。再取得してください。');
                const data = await response.json();
                if (!data || typeof data.total !== 'number' || !Array.isArray(data.items))
                    throw new Error('一覧の形式を確認できませんでした。');
                if (!controller.signal.aborted)
                    setLoaded({ key, data, error: '' });
            }
            catch (cause) {
                if (!controller.signal.aborted)
                    setLoaded({ key, data: null, error: cause instanceof Error ? cause.message : '取得に失敗しました。' });
            }
        })();
        return () => controller.abort();
    }, [url, key]);
    return loaded?.key === key ? { ...loaded, loading: false } : { data: null, error: '', loading: !!url };
}
function Notice({ loading, error }: {
    loading: boolean;
    error: string;
}) { return <>{loading && <p role="status">読み込み中...</p>}{error && <p role="alert">{error}</p>}</>; }
function Pages({ page, total, size, disabled, onPage, label }: {
    page: number;
    total: number;
    size: number;
    disabled: boolean;
    onPage: (page: number) => void;
    label: string;
}) { return <nav className={styles.controls} aria-label={label}><button disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>前へ</button><span>{total}件・{page}ページ目</span><button disabled={disabled || page * size >= total} onClick={() => onPage(page + 1)}>次へ</button></nav>; }
export default function RegistrationBrowser({ initialGroupId = null, initialScope = 'upcoming', invalidGroup = false }: { initialGroupId?: number | null; initialScope?: string; invalidGroup?: boolean } = {}) {
    const router = useRouter();
    function navigateGroup(id: number | null, nextScope = scope) {
        const params = new URLSearchParams({ scope: nextScope });
        if (id !== null) params.set('groupId', String(id));
        router.push(`/admin/registrations?${params}`, { scroll: false });
    }
    const [scope, setScope] = useState(initialScope), [groupPage, setGroupPage] = useState(1), [group, setGroup] = useState<{
        id: number;
        title: string;
    } | null>(initialGroupId ? { id: initialGroupId, title: `開催回ID ${initialGroupId}` } : null);
    const [classPage, setClassPage] = useState(1), [schedule, setSchedule] = useState<{
        id: number;
        title: string;
        date: string;
        start_time: string | null;
    } | null>(null);
    const [draft, setDraft] = useState(''), [q, setQ] = useState(''), [state, setState] = useState('all'), [cursors, setCursors] = useState(['']), [page, setPage] = useState(0);
    const [revision, setRevision] = useState(0), [groupRevision, setGroupRevision] = useState(0), [editing, setEditing] = useState<Parent | null>(null), [adding, setAdding] = useState<Parent | null>(null), [message, setMessage] = useState('');
    const busy = editing !== null || adding !== null;
    const groups = useRead<GroupResult>(endpoint('groups', { scope, page: groupPage }), groupRevision);
    const classes = useRead<ClassResult>(group ? endpoint('classes', { group: group.id, page: classPage }) : null, revision);
    const applicants = useRead<ItemResult>(group && schedule ? endpoint('items', { group: group.id, schedule: schedule.id, q, state, cursor: cursors[page] ?? '' }) : null, revision);
    function resetRows() { setPage(0); setCursors(['']); }
    function refresh() { resetRows(); setRevision(n => n + 1); }
    const seenParents = new Set<number>();
    return <section className={styles.page} aria-labelledby="browser-title">
  <Link href="/admin">← 管理ホームへ</Link><h1 id="browser-title">申込者管理</h1>
  <p>開催回とクラスを選択してください。件数は申込明細数です。日時は日本時間です。</p>
  {invalidGroup && <p role="alert">開催回IDが不正です。開催回を一覧から選択してください。</p>}
  <div className={styles.controls}><label htmlFor="occurrence-scope">開催回の表示</label><select id="occurrence-scope" value={scope} disabled={busy} onChange={e => { navigateGroup(null, e.target.value); setScope(e.target.value); setGroupPage(1); setGroup(null); setSchedule(null); setClassPage(1); resetRows(); }}>
   <option value="upcoming">開催予定</option><option value="all">すべて・履歴を含む</option><option value="ended">終了済み</option><option value="cancelled">中止</option><option value="hidden">非表示</option><option value="review">日付要確認</option>
  </select><button disabled={busy || groups.loading || classes.loading || applicants.loading} onClick={() => { setGroupRevision(n => n + 1); refresh(); }}>再取得</button></div>
  <Notice loading={groups.loading} error={groups.error}/>
  {groups.data && <><h2>開催回</h2><div className={styles.choices}>{groups.data.items.map(item => <button key={item.id} aria-pressed={group?.id === item.id} disabled={busy} onClick={() => { navigateGroup(item.id); setGroup({ id: item.id, title: item.title }); setClassPage(1); setSchedule(null); resetRows(); setMessage(''); }}><strong>{item.title}</strong><span>{item.start_date ?? '日付不明'} ～ {item.end_date ?? '日付不明'} · ID {item.id}</span><span>{indexLabels(item).join('・')}</span></button>)}</div>
   {!groups.data.items.length && <p>該当する開催回はありません。</p>}<Pages page={groupPage} total={groups.data.total} size={groups.data.pageSize} disabled={busy || groups.loading} onPage={n => { setGroupPage(n); setSchedule(null); resetRows(); }} label="開催回のページ切替"/></>}
  {group && <section aria-labelledby="classes-title"><h2 id="classes-title">{classes.data?.group.title ?? group.title}（開催回ID {group.id}）</h2><Notice loading={classes.loading} error={classes.error ? `指定された開催回を確認できません。一覧から選択するか再取得してください。${classes.error}` : ""}/>
   {classes.data && <><div className={styles.choices}>{classes.data.items.map(item => <button key={item.id} aria-pressed={schedule?.id === item.id} disabled={busy} onClick={() => { setSchedule(item); setQ(''); setDraft(''); setState('all'); resetRows(); setMessage(''); }}><strong>{item.title}</strong><span>{item.date} {item.start_time ?? ''} · クラスID {item.id}</span><span>有効 {item.active_items[0].count}件 ／ 取消済み {item.cancelled_items[0].count}件</span></button>)}</div>{!classes.data.items.length && <p>クラスはありません。</p>}<Pages page={classPage} total={classes.data.total} size={classes.data.pageSize} disabled={busy || classes.loading} onPage={n => { setClassPage(n); setSchedule(null); resetRows(); }} label="クラスのページ切替"/></>}
  </section>}
  {group && schedule && <section aria-labelledby="class-applicants-title"><h2 id="class-applicants-title">{schedule.title} の申込者（クラスID {schedule.id}）</h2>
   <form className={styles.controls} onSubmit={e => { e.preventDefault(); if (!busy) {
            setQ(draft.trim());
            resetRows();
        } }}><label htmlFor="participant-search">申込者名</label><input id="participant-search" maxLength={100} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)}/><button disabled={busy || applicants.loading}>検索</button><label htmlFor="item-state">状態</label><select id="item-state" value={state} disabled={busy} onChange={e => { setState(e.target.value); resetRows(); }}><option value="all">すべて</option><option value="active">有効</option><option value="cancelled">取消済み</option></select></form>
   {editing && <RegistrationDetailsForm key={editing.id} registration={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setMessage('申込者情報を更新しました。'); refresh(); }}/>}
   {adding && <AddRegistrationItems key={adding.id} registrationId={adding.id} participantName={adding.name} eventGroupTitle={classes.data?.group.title ?? group.title} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); setMessage('申込クラスを追加しました。'); refresh(); }}/>}
   {message && <p role="status">{message}</p>}<Notice loading={applicants.loading} error={applicants.error}/>
   {applicants.data && <><p role="status">検索条件に一致する明細 {applicants.data.total}件</p>{applicants.data.items.length === 0 ? <p>該当する申込はありません。</p> : <table className={styles.table}><thead><tr>{['申込者', '連絡先・備考', '状態・申込日時', '操作'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{applicants.data.items.map(item => {
                        const parent = item.registration, known = parent && parent.id === item.registration_id && parent.event_group_id === group.id;
                        const actions = known && !seenParents.has(parent.id);
                        if (known)
                            seenParents.add(parent.id);
                        return <tr key={item.id}><td data-label="申込者">{known ? parent.name : '関連先不明'}<small>申込ID {item.registration_id} ／ 明細ID {item.id}</small></td><td data-label="連絡先・備考">{known ? <>{parent.contact}{parent.notes && <p>{parent.notes}</p>}</> : '関連先不明'}</td><td data-label="状態・申込日時"><strong>{item.status === 'active' ? '有効' : '取消済み'}</strong><small>{new Date(item.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</small>{item.cancelled_at && <small>取消：{new Date(item.cancelled_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</small>}</td><td data-label="操作"><div className={styles.controls}>{actions && <><button disabled={busy} onClick={() => { setMessage(''); setEditing(parent); }}>情報を編集</button><button disabled={busy} onClick={() => { setMessage(''); setAdding(parent); }}>クラスを追加</button></>}
     <CancelRegistrationItem itemId={item.id} status={item.status} participantName={known ? parent.name : ''} eventGroupTitle={classes.data?.group.title ?? group.title} classTitle={schedule.title} date={schedule.date} startTime={schedule.start_time} disabled={busy || !known} onCancelled={() => { setMessage('申込クラスを取り消しました。'); refresh(); }}/></div></td></tr>;
                    })}</tbody></table>}
   <nav className={styles.controls} aria-label="申込明細のページ切替"><button disabled={busy || applicants.loading || page === 0} onClick={() => setPage(n => n - 1)}>前のページ</button><span>{page + 1}ページ目</span><button disabled={busy || applicants.loading || !applicants.data.nextCursor} onClick={() => { if (applicants.data?.nextCursor) {
                setCursors(old => [...old.slice(0, page + 1), applicants.data!.nextCursor!]);
                setPage(n => n + 1);
            } }}>次のページ</button></nav></>}
  </section>}
 </section>;
}
