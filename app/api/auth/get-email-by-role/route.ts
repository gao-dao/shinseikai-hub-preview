import { NextResponse } from 'next/server'

// Retired: authentication must never expose account lookup results.
export async function POST() {
    return NextResponse.json({ error: 'このAPIは利用できません' }, {
        status: 410, headers: { 'Cache-Control': 'no-store' },
    })
}
