import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'

export async function POST(request: Request) {
    const authorization = await requireAdmin()
    if (!authorization.ok) {
        return NextResponse.json(
            { error: authorization.error },
            { status: authorization.status }
        )
    }

    const { target, userId, newPassword } = await request.json()

    if (!newPassword || newPassword.length < 6) {
        return NextResponse.json({ error: 'パスワードは6文字以上必要です' }, { status: 400 })
    }

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SECRET_KEY!
    )

    let targetUserId = userId

    // 会員共通アカウントのパスワード変更
    if (target === 'member_shared') {
        const memberEmail = process.env.MEMBER_SHARED_EMAIL
        if (!memberEmail) {
            return NextResponse.json({ error: 'MEMBER_SHARED_EMAIL が設定されていません' }, { status: 400 })
        }
        const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 })
        const found = users.find(u => u.email === memberEmail)
        if (!found) {
            return NextResponse.json({ error: '会員共通アカウントが見つかりません' }, { status: 404 })
        }
        targetUserId = found.id
    }

    if (!targetUserId) {
        return NextResponse.json({ error: 'ユーザーIDが必要です' }, { status: 400 })
    }

    const { error } = await supabase.auth.admin.updateUserById(targetUserId, { password: newPassword })
    if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 })
    }

    return NextResponse.json({ success: true })
}
