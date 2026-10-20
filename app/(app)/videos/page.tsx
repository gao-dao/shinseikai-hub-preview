'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

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
        .cat-btn { flex: 1 1 0; min-width: 0; background: #fff; border: 1px solid #EDE8DF; color: #64748B; padding: 7px 8px; border-radius: 20px; font-size: 12px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: all .2s; box-shadow: 0 1px 4px rgba(0,0,0,.04); }
        .cat-btn:hover { border-color: #6B1F2B; color: #6B1F2B; }
        .cat-btn.active { background: #6B1F2B; color: #fff; border-color: #6B1F2B; box-shadow: 0 2px 8px rgba(107,31,43,.3); }
        .vgrid { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
        .vcard { background: #fff; border: 1px solid #EDE8DF; border-radius: 14px; overflow: hidden; cursor: pointer; transition: all .2s; box-shadow: 0 2px 8px rgba(0,0,0,.04); }
        .vcard:hover { border-color: #6B1F2B; box-shadow: 0 6px 20px rgba(107,31,43,.12); transform: translateY(-2px); }
        .vthumb { height: 90px; background: linear-gradient(135deg, #F7EEF0, #EEDDE1); display: flex; align-items: center; justify-content: center; position: relative; }
        .pring { width: 44px; height: 44px; border-radius: 50%; border: 2px solid #6B1F2B; background: rgba(107,31,43,.1); display: flex; align-items: center; justify-content: center; font-size: 16px; padding-left: 3px; color: #6B1F2B; transition: all .2s; }
        .vcard:hover .pring { background: #6B1F2B; color: #fff; transform: scale(1.1); }
        .vdur { position: absolute; bottom: 6px; right: 8px; font-size: 10px; background: rgba(0,0,0,.5); border-radius: 4px; padding: 2px 6px; color: #fff; }
        .vinfo { padding: 12px 14px; }
        .vtitle { font-size: 12px; font-weight: 700; margin-bottom: 4px; line-height: 1.4; color: #1E293B; }
        .vdesc { font-size: 10px; color: #64748B; margin-bottom: 8px; line-height: 1.5; }
        .vtag { font-size: 9px; border-radius: 20px; padding: 2px 8px; font-weight: 700; }
        .modal-bg { position: fixed; inset: 0; background: rgba(30,41,59,.6); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 20px; backdrop-filter: blur(4px); }
        .modal { background: #fff; border: 1px solid #EDE8DF; border-radius: 16px; width: 100%; max-width: 640px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.15); }
        .modal-head { padding: 18px 22px; border-bottom: 1px solid #EDE8DF; display: flex; justify-content: space-between; align-items: center; background: #FAF7F0; }
        .modal-title { font-size: 15px; font-weight: 700; color: #1E293B; }
        .close-btn { background: none; border: none; color: #94A3B8; font-size: 22px; cursor: pointer; line-height: 1; transition: color .18s; }
        .close-btn:hover { color: #6B1F2B; }
        .iframe-wrap { position: relative; padding-bottom: 56.25%; height: 0; }
        .iframe-wrap iframe { position: absolute; inset: 0; width: 100%; height: 100%; }
        .empty { text-align: center; color: #94A3B8; font-size: 13px; padding: 80px 20px; }
        @media(min-width:901px) { .vgrid { grid-template-columns: repeat(4,1fr); } }
      `}</style>
      <div className="sp">
        <div className="sec-hd">動画ライブラリ</div>

        <div className="cat-scroll">
          {categories.map(c => (
            <button
              key={c}
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
              <div key={v.id} className="vcard" onClick={() => setSelected(v)}>
                <div className="vthumb">
                  <div className="pring">▶</div>
                  {v.duration && <div className="vdur">{v.duration}</div>}
                </div>
                <div className="vinfo">
                  <div className="vtitle">{v.title}</div>
                  <div className="vdesc">{v.description}</div>
                  {v.tag && <span className="vtag" style={tagStyle[v.tag]}>{v.tag}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {selected && (
        <div className="modal-bg" onClick={() => setSelected(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <span className="modal-title">{selected.title}</span>
              <button className="close-btn" onClick={() => setSelected(null)}>✕</button>
            </div>


            <div style={{ padding: '20px', textAlign: 'center' }}>
              <p style={{ color: '#6868a0', fontSize: '13px', marginBottom: '16px' }}>
                YouTubeで動画を開きます
              </p>
              <a
                href={selected.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-block',
                  background: 'linear-gradient(135deg, #6B1F2B, #8A3041)',
                  color: '#fff',
                  fontWeight: '700',
                  fontSize: '14px',
                  padding: '12px 32px',
                  borderRadius: '10px',
                  textDecoration: 'none',
                  boxShadow: '0 4px 12px rgba(107,31,43,.2)'
                }}
              >
                ▶ 動画を再生する
              </a>

            </div>
          </div>
        </div>
      )}
    </>
  )
}
