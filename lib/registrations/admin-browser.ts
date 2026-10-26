import { calendarDay } from '@/lib/event-groups/presentation';
import type { IndexItem } from '@/lib/event-groups/admin-index';
export type Options = {
    resource: 'groups' | 'classes' | 'items' | 'history';
    page: number;
    group: number;
    schedule: number;
    scope: string;
    q: string;
    state: string;
    cursor: string;
};
export type Parent = {
    id: number;
    event_group_id: number;
    name: string;
    contact: string;
    notes: string | null;
    created_at: string;
};
export type ClassRow = {
    id: number;
    event_group_id: number;
    title: string;
    date: string;
    start_time: string | null;
    active_items: {
        count: number;
    }[];
    cancelled_items: {
        count: number;
    }[];
};
export type ItemRow = {
    id: number;
    registration_id: number;
    event_group_id: number;
    schedule_id: number;
    status: 'active' | 'cancelled';
    created_at: string;
    cancelled_at: string | null;
    registration: Parent | null;
};
export type GroupResult = {
    items: IndexItem[];
    total: number;
    page: number;
    pageSize: number;
};
export type ClassResult = {
    group: {
        id: number;
        title: string;
    };
    items: ClassRow[];
    total: number;
    page: number;
    pageSize: number;
};
export type ItemResult = {
    items: ItemRow[];
    total: number;
    nextCursor: string | null;
    pageSize: number;
};
export function positive(value: string) {
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error('invalid id');
    return Number(value);
}
export function readCursor(value: string) {
    const parts = value.split('|');
    if (parts.length !== 2 || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(parts[0]) || !calendarDay(parts[0].slice(0, 10)))
        throw new Error('invalid cursor');
    return { time: parts[0], id: positive(parts[1]) };
}
export function makeCursor(row: {
    created_at: string;
    id: number;
}) { const value = `${row.created_at}|${row.id}`; readCursor(value); return value; }
export function readOptions(params: URLSearchParams): Options {
    const resource = params.get('resource') ?? 'groups';
    if (!['groups', 'classes', 'items', 'history'].includes(resource))
        throw new Error('invalid resource');
    const allowed = resource === 'groups' ? ['resource', 'scope', 'page'] : resource === 'classes' ? ['resource', 'group', 'page'] : resource === 'items' ? ['resource', 'group', 'schedule', 'q', 'state', 'cursor'] : ['resource', 'page', 'cursor'];
    for (const key of params.keys())
        if (!allowed.includes(key) || params.getAll(key).length !== 1)
            throw new Error('invalid filters');
    const page = positive(params.get('page') ?? '1'), scope = params.get('scope') ?? 'upcoming', q = (params.get('q') ?? '').trim(), state = params.get('state') ?? 'all', cursor = params.get('cursor') ?? '';
    if (page > 10000 || !['upcoming', 'all', 'ended', 'cancelled', 'hidden', 'review'].includes(scope) || (params.get('q') ?? '').length > 100 || /[\u0000-\u001f]/.test(params.get('q') ?? '') || !['all', 'active', 'cancelled'].includes(state))
        throw new Error('invalid filters');
    if (cursor)
        readCursor(cursor);
    return { resource: resource as Options['resource'], page, scope, q, state, cursor, group: resource === 'classes' || resource === 'items' ? positive(params.get('group') ?? '') : 0, schedule: resource === 'items' ? positive(params.get('schedule') ?? '') : 0 };
}
export function groupMatches(item: IndexItem, scope: string) {
    if (scope === 'upcoming')
        return item.phase === 'upcoming' && !item.is_cancelled && !item.is_hidden;
    if (scope === 'ended')
        return item.phase === 'ended';
    if (scope === 'cancelled')
        return item.is_cancelled;
    if (scope === 'hidden')
        return item.is_hidden;
    if (scope === 'review')
        return item.phase === 'unknown';
    return true;
}
export function sortGroups(items: IndexItem[]) {
    const rank = (g: IndexItem) => g.phase === 'unknown' ? 2 : g.phase === 'upcoming' && !g.is_cancelled && !g.is_hidden ? 0 : 1;
    return [...items].sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? (b.start_date ?? '').localeCompare(a.start_date ?? '') : (a.start_date ?? '').localeCompare(b.start_date ?? '')) || a.id - b.id);
}
export function escapedName(value: string) { return `%${value.replace(/[\\%_]/g, '\\$&')}%`; }
