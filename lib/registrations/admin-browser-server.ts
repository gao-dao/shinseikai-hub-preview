import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { tokyoDay } from '@/lib/event-groups/presentation';
import { classifyIndex, type IndexGroup, type IndexItem } from '@/lib/event-groups/admin-index';
import { escapedName, groupMatches, makeCursor, readCursor, sortGroups, type Options, type ClassRow, type ItemRow } from './admin-browser';
type DB = Awaited<ReturnType<typeof createClient>>;
const size = 20, rows = 50, batch = 500, limit = 100000;
function checked<T>(data: T[] | null, error: unknown, count: number | null, offset: number, take: number) {
    if (error || !data || count === null || !Number.isSafeInteger(count) || count < 0 || data.length !== Math.min(take, Math.max(0, count - offset)))
        throw new Error('incomplete read');
    return { data, count };
}
function unique(data: {
    id: number;
}[]) { const ids = new Set<number>(); for (const r of data) {
    if (!Number.isSafeInteger(r.id) || r.id <= 0 || ids.has(r.id))
        throw new Error('invalid rows');
    ids.add(r.id);
} }
// Exact HEAD counts work with the existing PostgREST configuration; no SQL aggregate setting is required.
async function addCounts(db: DB, items: Omit<ClassRow, 'active_items' | 'cancelled_items'>[]): Promise<ClassRow[]> {
    return Promise.all(items.map(async (item) => {
        const counts = await Promise.all((['active', 'cancelled'] as const).map(async (status) => {
            const result = await db.from('registration_items').select('id', { count: 'exact', head: true }).eq('event_group_id', item.event_group_id).eq('schedule_id', item.id).eq('status', status);
            if (result.error || result.count === null || !Number.isSafeInteger(result.count) || result.count < 0)
                throw new Error('count failed');
            return [{ count: result.count }];
        }));
        return { ...item, active_items: counts[0], cancelled_items: counts[1] };
    }));
}
// Uses only the authenticated caller's SSR client/RLS. Entry route must requireAdmin first.
export async function loadBrowser(options: Options, db: DB, today = tokyoDay()) {
    const o = options;
    if (o.resource === 'groups') {
        const groups: IndexGroup[] = [], dates = new Map<number, unknown[]>();
        let expected: number | undefined;
        for (let offset = 0;; offset += batch) {
            if (offset >= 10000)
                throw new Error('group read limit');
            const result = await db.from('event_groups').select('id,title,city,start_date,end_date,is_cancelled,is_hidden', { count: 'exact' }).order('id').range(offset, offset + batch - 1);
            const got = checked(result.data, result.error, result.count, offset, batch);
            if (expected !== undefined && expected !== got.count)
                throw new Error('groups changed');
            expected = got.count;
            groups.push(...got.data as IndexGroup[]);
            if (groups.length === got.count)
                break;
        }
        unique(groups);
        for (const g of groups)
            dates.set(g.id, []);
        // Bounded batches, never one request per occurrence. Read every class date before classification/paging.
        for (let start = 0; start < groups.length; start += 100) {
            const ids = groups.slice(start, start + 100).map(g => g.id);
            let expectedDates: number | undefined;
            const seen = new Set<number>();
            for (let offset = 0;; offset += batch) {
                if (offset >= limit)
                    throw new Error('class date read limit');
                const result = await db.from('schedules').select('id,event_group_id,date', { count: 'exact' }).in('event_group_id', ids).order('id').range(offset, offset + batch - 1);
                const got = checked(result.data, result.error, result.count, offset, batch);
                if (expectedDates !== undefined && expectedDates !== got.count)
                    throw new Error('classes changed');
                expectedDates = got.count;
                for (const row of got.data) {
                    if (!dates.has(row.event_group_id) || seen.has(row.id))
                        throw new Error('invalid class');
                    seen.add(row.id);
                    dates.get(row.event_group_id)!.push(row.date);
                }
                if (seen.size === got.count)
                    break;
            }
        }
        const items: IndexItem[] = sortGroups(groups.map(g => classifyIndex(g, dates.get(g.id)!, today)).filter(g => groupMatches(g, o.scope)));
        return { items: items.slice((o.page - 1) * size, o.page * size), total: items.length, page: o.page, pageSize: size };
    }
    if (o.resource === 'classes' || o.resource === 'items') {
        const { data: group, error } = await db.from('event_groups').select('id,title').eq('id', o.group).maybeSingle();
        if (error || !group)
            throw new Error('group unavailable');
        if (o.resource === 'classes') {
            const start = (o.page - 1) * size, result = await db.from('schedules').select('id,event_group_id,title,date,start_time', { count: 'exact' }).eq('event_group_id', o.group).order('date').order('start_time').order('id').range(start, start + size - 1);
            const got = checked(result.data, result.error, result.count, start, size);
            unique(got.data);
            const items = await addCounts(db, got.data);
            return { group, items, total: got.count, page: o.page, pageSize: size };
        }
        const { data: schedule, error: classError } = await db.from('schedules').select('id').eq('id', o.schedule).eq('event_group_id', o.group).maybeSingle();
        if (classError || !schedule)
            throw new Error('class unavailable');
        const fields = `id,registration_id,event_group_id,schedule_id,status,created_at,cancelled_at,registration:registrations!registration_items_registration_group_fkey${o.q ? '!inner' : ''}(id,event_group_id,name,contact,notes,created_at)`;
        const base = (head = false) => {
            let q = db.from('registration_items').select(fields, { count: 'exact', head }).eq('event_group_id', o.group).eq('schedule_id', o.schedule);
            if (o.state !== 'all')
                q = q.eq('status', o.state);
            if (o.q)
                q = q.ilike('registration.name', escapedName(o.q));
            return q;
        };
        let query = base();
        if (o.cursor) {
            const c = readCursor(o.cursor);
            query = query.or(`created_at.lt.${c.time},and(created_at.eq.${c.time},id.lt.${c.id})`);
        }
        const result = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, rows);
        const got = checked(result.data, result.error, result.count, 0, rows + 1);
        const items = got.data.slice(0, rows) as unknown as ItemRow[];
        unique(items);
        let total = got.count;
        if (o.cursor) {
            const count = await base(true);
            if (count.error || count.count === null)
                throw new Error('count failed');
            total = count.count;
        }
        return { items, total, pageSize: rows, nextCursor: got.data.length > rows ? makeCursor(items[items.length - 1]) : null };
    }
    // Preserve every parent, including unresolved relations; explicitly page ALL child items.
    let query = db.from('registrations').select('id,event_group_id,name,contact,notes,created_at,event_groups!registrations_event_group_id_fkey(id,title)', { count: 'exact' });
    if (o.cursor) {
        const c = readCursor(o.cursor);
        query = query.or(`created_at.lt.${c.time},and(created_at.eq.${c.time},id.lt.${c.id})`);
    }
    const result = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, rows);
    const got = checked(result.data, result.error, result.count, 0, rows + 1);
    const parents = got.data.slice(0, rows);
    unique(parents);
    const children = new Map<number, Record<string, unknown>[]>(parents.map(p => [p.id, []]));
    if (parents.length) {
        let expected: number | undefined;
        const seen = new Set<number>();
        for (let offset = 0;; offset += batch) {
            if (offset >= limit)
                throw new Error('history item read limit');
            const result = await db.from('registration_items').select('id,registration_id,event_group_id,schedule_id,status,created_at,cancelled_at,schedules!registration_items_schedule_group_fkey(id,title,date,start_time)', { count: 'exact' }).in('registration_id', parents.map(p => p.id)).order('id').range(offset, offset + batch - 1);
            const part = checked(result.data, result.error, result.count, offset, batch);
            if (expected !== undefined && expected !== part.count)
                throw new Error('history changed');
            expected = part.count;
            for (const child of part.data) {
                if (seen.has(child.id) || !children.has(child.registration_id))
                    throw new Error('invalid child');
                seen.add(child.id);
                children.get(child.registration_id)!.push(child);
            }
            if (seen.size === part.count)
                break;
        }
    }
    let total = got.count;
    if (o.cursor) {
        const c = await db.from('registrations').select('id', { count: 'exact', head: true });
        if (c.error || c.count === null)
            throw new Error('count failed');
        total = c.count;
    }
    return { registrations: parents.map(p => ({ ...p, registration_items: children.get(p.id) })), total, page: o.page, pageSize: rows, nextCursor: got.data.length > rows ? makeCursor(parents[parents.length - 1]) : null };
}
