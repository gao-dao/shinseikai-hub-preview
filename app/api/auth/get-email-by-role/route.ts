import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
    const { role } = await request.json()

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SECRET_KEY!
    )

    if (role === 'member') {
        const memberEmail = process.env.MEMBER_SHARED_EMAIL
        if (!memberEmail) {
            return NextResponse.json(
                { error: '会員共通アカウントが未設定です（MEMBER_SHARED_EMAIL を .env.local に設定してください）' },
                { status: 400 }
            )
        }
        return NextResponse.json({ email: memberEmail })
    }

    // 管理者 → profiles テーブルから admin ロールのメールを取得
    const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .limit(1)
        .single()

    if (!profile) {
        return NextResponse.json({ error: '管理者アカウントが見つかりません' }, { status: 404 })
    }

    const { data: { user }, error } = await supabase.auth.admin.getUserById(profile.id)
    if (error || !user?.email) {
        return NextResponse.json({ error: '管理者のメールアドレスが取得できません' }, { status: 400 })
    }

    return NextResponse.json({ email: user.email })
}
