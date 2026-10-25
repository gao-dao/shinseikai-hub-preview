'use client'
import { useEffect, useRef, type RefObject } from 'react'

export default function VideoDialog({ video, opener, onClose }: { video: { title: string; url: string }; opener: RefObject<HTMLButtonElement | null>; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const element = dialog.current
    const trigger = opener.current
    if (!element) return
    element.showModal()
    closeButton.current?.focus({ preventScroll: true })
    return () => {
      element.close()
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [opener])
  return <dialog id="video-dialog" className="video-modal" ref={dialog} aria-labelledby="video-dialog-title"
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div>
      <div className="modal-head">
        <h2 id="video-dialog-title" className="modal-title">{video.title}</h2>
        <button type="button" className="close-btn" ref={closeButton} aria-label="動画の詳細を閉じる" onClick={onClose}>✕</button>
      </div>
      <div className="modal-body">
        <p>YouTubeで動画を開きます</p>
        <a className="video-play-link" href={video.url} target="_blank" rel="noopener noreferrer">▶ 動画を再生する</a>
      </div>
    </div>
  </dialog>
}
