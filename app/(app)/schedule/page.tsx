'use client'
import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'

type ScheduleType = '稽古会' | '一般参加'

type Schedule = {
  id: number
  title: string
  date: string
  start_time: string | null
  end_time: string | null
  location: string
  event_group: { is_cancelled: boolean; is_hidden: boolean } | null
  type: ScheduleType
}

const dotColor: Record<ScheduleType, string> = { '稽古会': '#6B1F2B', '一般参加': '#8A6A3D' }
const typeLabel: Record<ScheduleType, string> = { '稽古会': '稽古会', '一般参加': '一般参加' }

export default function SchedulePage() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    supabase.from('schedules')
      .select('*, event_group:event_groups(is_cancelled, is_hidden)')
      .order('date', { ascending: true })
      .then(({ data }) => { if (data) setSchedules((data as unknown as Schedule[]).filter(row => !row.event_group?.is_hidden)) })
  }, [supabase])

  return (
    <>
      <style>{`
        .sp { flex: 1; overflow-y: auto; padding: 24px 20px; background: #FAF7F0; }
        .sec-hd { font-size: 13px; font-weight: 700; color: #6B1F2B; letter-spacing: .15em; text-transform: uppercase; margin-bottom: 20px; display: flex; align-items: center; gap: 12px; }
        .sec-hd::before, .sec-hd::after { content: ''; flex: 1; height: 1px; background: #EDE8DF; }
        .slist { display: flex; flex-direction: column; gap: 12px; }
        .sitem { background: #fff; border: 1px solid #EDE8DF; border-radius: 14px; padding: 18px 22px; display: flex; align-items: flex-start; gap: 16px; transition: all .2s; box-shadow: 0 2px 8px rgba(0,0,0,.04); }
        .sitem:hover { border-color: #6B1F2B; box-shadow: 0 4px 16px rgba(107,31,43,.1); transform: translateY(-1px); }
        .sdot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; margin-top: 6px; }
        .sinfo { flex: 1; min-width: 0; }
        .stitle { font-size: 16px; font-weight: 700; margin-bottom: 8px; color: #1E293B; }
        .smeta { font-size: 13px; color: #64748B; display: flex; flex-wrap: wrap; gap: 6px 16px; }
        .stype { font-size: 11px; border-radius: 20px; padding: 3px 10px; font-weight: 700; flex-shrink: 0; margin-top: 3px; }
        .empty { text-align: center; color: #94A3B8; font-size: 14px; padding: 80px 20px; }
      `}</style>
      <div className="sp">
        <div className="sec-hd">スケジュール</div>
        {schedules.length === 0 ? (
          <div className="empty">スケジュールはまだ登録されていません</div>
        ) : (
          <div className="slist">
            {schedules.map(s => (
              <div key={s.id} className="sitem">
                <div className="sdot" style={{ background: dotColor[s.type] }} />
                <div className="sinfo">
                  <div className="stitle">{s.title}{s.event_group?.is_cancelled && <strong>（開催中止）</strong>}</div>
                  <div className="smeta">
                    <span>📅 {s.date}</span>
                    {(s.start_time || s.end_time) && (
                      <span>⏰ {s.start_time || '--:--'} – {s.end_time || '--:--'}</span>
                    )}
                    <span>📍 {s.location}</span>
                  </div>
                </div>
                <span className="stype" style={{
                  background: s.type === '稽古会' ? 'rgba(107,31,43,.12)' : 'rgba(138,106,61,.12)',
                  color: dotColor[s.type]
                }}>{typeLabel[s.type]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
