import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/supabase/require-admin';
import { createClient } from '@/lib/supabase/server';
import { readOptions } from '@/lib/registrations/admin-browser';
import { loadBrowser } from '@/lib/registrations/admin-browser-server';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Cookie' };
export async function GET(request: NextRequest) {
    const auth = await requireAdmin();
    if (!auth.ok)
        return NextResponse.json({ error: '管理者権限が必要です。' }, { status: auth.status, headers });
    let options;
    try {
        options = readOptions(request.nextUrl.searchParams);
    }
    catch {
        return NextResponse.json({ error: '検索条件が不正です。' }, { status: 400, headers });
    }
    try {
        return NextResponse.json(await loadBrowser(options, await createClient()), { headers });
    }
    catch {
        return NextResponse.json({ error: '一覧を完全に取得できませんでした。再取得してください。取得上限に達した場合は管理者による確認が必要です。' }, { status: 503, headers });
    }
}
