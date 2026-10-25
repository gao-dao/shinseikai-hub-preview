'use client'
import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import VideoDialog from './video-dialog'

type Video = {
  id: number
  title: string
  description: string
  url: string
  duration: string
  tag: string
}

const tagStyle: Record<string, { background: string; color: string }> = {
  '基本型': { background: 'rgba(200,168,75,.15)', color: '#c8a84b' },
  '稽古動画': { background: 'rgba(75,200,122,.15)', color: '#2f9e5a' },
  '参考動画': { background: 'rgba(75,138,200,.15)', color: '#4b8ac8' },
}

export default function VideosPage() {
  const [videos, setVideos] = useState<Video[]>([])
  const [selected, setSelected] = useState<Video | null>(null)
  const [category, setCategory] = useState('全て')
  const [loading, setLoading] = useState(true)
  const supabase = createClient()
  const router = useRouter()
  const opener = useRef<HTMLButtonElement | null>(null)

  const categories = ['全て', '基本型', '稽古動画', '参考動画']
  const filteredVideos = videos.filter(v => category === '全て' || v.tag === category)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.push('/login')
      } else {
        supabase.from('videos')
          .select('*')
          .order('created_at', { ascending: false })
          .then(({ data }) => {
            if (data) setVideos(data as Video[])
            setLoading(false)
          })
      }
    })
  }, [router, supabase])

  if (loading) return <div style={{ padding: '40px', color: '#6868a0', textAlign: 'center' }}>読み込み中...</div>

  return (
    <>
      <style>{`
        .sp { flex: 1; overflow-y: auto; padding: 24px 20px; background: #FAF7F0; }
        .sec-hd { font-size: 13px; font-weight: 700; color: #6B1F2B; letter-spacing: .15em; text-transform: uppercase; margin-bottom: 20px; display: flex; align-items: center; gap: 12px; }
        .sec-hd::before, .sec-hd::after { content: ''; flex: 1; height: 1px; background: #EDE8DF; }
        .cat-scroll { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 24px; scrollbar-width: none; }
        .cat-scroll::-webkit-scrollbar { display: none; }
        .cat-btn { min-height: 44px; flex: 1 1 0; min-width: 0; background: #fff; border: 1px solid #EDE8DF; color: #64748B; padding: 7px 8px; border-radius: 20px; font-size: 12px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: all .2s; box-shadow: 0 1px 4px rgba(0,0,0,.04); }
        .cat-btn:hover { border-color: #6B1F2B; color: #6B1F2B; }
        .cat-btn.active { background: #6B1F2B; color: #fff; border-color: #6B1F2B; box-shadow: 0 2px 8px rgba(107,31,43,.3); }
        .vgrid { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
        .vcard { display: block; width: 100%; padding: 0; text-align: left; font: inherit; background: #fff; border: 1px solid #EDE8DF; border-radius: 14px; overflow: hidden; cursor: pointer; transition: all .2s; box-shadow: 0 2px 8px rgba(0,0,0,.04); }
        .vcard:hover { border-color: #6B1F2B; box-shadow: 0 6px 20px rgba(107,31,43,.12); transform: translateY(-2px); }
        .vthumb { height: 90px; background: linear-gradient(135deg, #F7EEF0, #EEDDE1); display: flex; align-items: center; justify-content: center; position: relative; }
        .pring { width: 44px; height: 44px; border-radius: 50%; border: 2px solid #6B1F2B; background: rgba(107,31,43,.1); display: flex; align-items: center; justify-content: center; font-size: 16px; padding-left: 3px; color: #6B1F2B; transition: all .2s; }
        .vcard:hover .pring { background: #6B1F2B; color: #fff; transform: scale(1.1); }
        .vdur { position: absolute; bottom: 6px; right: 8px; font-size: 10px; background: rgba(0,0,0,.5); border-radius: 4px; padding: 2px 6px; color: #fff; }
        .vinfo { display: block; padding: 12px 14px; }
        .vtitle { display: block; font-size: 12px; font-weight: 700; margin-bottom: 4px; line-height: 1.4; color: #1E293B; }
        .vdesc { display: block; font-size: 10px; color: #64748B; margin-bottom: 8px; line-height: 1.5; }
        .vtag { font-size: 9px; border-radius: 20px; padding: 2px 8px; font-weight: 700; }
        .video-modal::backdrop { background: rgba(30,41,59,.6); }
        .video-modal { margin: auto; padding: 0; color: #1E293B; background: #fff; border: 1px solid #EDE8DF; border-radius: 16px; width: calc(100% - 32px); max-width: 640px; max-height: calc(100dvh - 32px); overflow: auto; box-shadow: 0 20px 60px rgba(0,0,0,.15); }
        .modal-head { padding: 18px 22px; border-bottom: 1px solid #EDE8DF; display: flex; justify-content: space-between; align-items: center; background: #FAF7F0; }
        .modal-title { font-size: 15px; font-weight: 700; color: #1E293B; }
        .close-btn { min-width: 44px; min-height: 44px; background: none; border: none; color: #94A3B8; font-size: 22px; cursor: pointer; line-height: 1; transition: color .18s; }
        .close-btn:hover { color: #6B1F2B; }
        .iframe-wrap { position: relative; padding-bottom: 56.25%; height: 0; }
        .iframe-wrap iframe { position: absolute; inset: 0; width: 100%; height: 100%; }
        .empty { text-align: center; color: #94A3B8; font-size: 13px; padding: 80px 20px; }
        @media(min-width:901px) { .vgrid { grid-template-columns: repeat(4,1fr); } }
        .sp button:focus-visible, .video-modal :focus-visible { outline: 2px solid #6B1F2B; outline-offset: 3px; }
        .vcard:focus-visible { outline-offset: -3px; }
        .modal-body { padding: 20px; text-align: center; }
        .modal-body p { color: #52616e; font-size: 14px; margin-bottom: 16px; }
        .video-play-link { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 12px 24px; border-radius: 8px; background: #6B1F2B; color: #fff; font-weight: 700; text-decoration: none; }
        @media(max-width:400px) { .vgrid { grid-template-columns: 1fr; } .cat-btn { flex: 0 0 auto; padding: 8px 12px; } }
      `}</style>
      <div className="sp">
        <div className="sec-hd">動画ライブラリ</div>

        <div className="cat-scroll">
          {categories.map(c => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={`cat-btn ${category === c ? 'active' : ''}`}
            >
              {c}
            </button>
          ))}
        </div>

        {filteredVideos.length === 0 ? (
          <div className="empty">動画はまだ登録されていません</div>
        ) : (
          <div className="vgrid">
            {filteredVideos.map(v => (
              <button type="button" key={v.id} className="vcard" aria-label={`${v.title}を開く`} aria-haspopup="dialog" aria-controls="video-dialog"
                onClick={event => { opener.current = event.currentTarget; setSelected(v) }}>
                <span className="vthumb">
                  <span className="pring" aria-hidden="true">▶</span>
                  {v.duration && <span className="vdur">{v.duration}</span>}
                </span>
                <span className="vinfo">
                  <span className="vtitle">{v.title}</span>
                  <span className="vdesc">{v.description}</span>
                  {v.tag && <span className="vtag" style={tagStyle[v.tag]}>{v.tag}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected && <VideoDialog key={selected.id} video={selected} opener={opener} onClose={() => setSelected(null)} />}
    </>
  )
}
