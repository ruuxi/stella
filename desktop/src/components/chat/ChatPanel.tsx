/**
 * ChatPanel: Collapsible right panel that wraps the chat interface.
 * Provides resize handle, open/close animation, and collapse toggle.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  MAX_CHAT_WIDTH_RATIO,
  MIN_CHAT_WIDTH,
  useWorkspace,
} from '@/app/state/workspace-state'

const ANIM_DURATION = 350 // ms, matches CSS chat-slide-out duration

export function ChatPanel({ children }: { children: ReactNode }) {
  const { state, setChatWidth, setChatOpen } = useWorkspace()
  const { chatWidth, isChatOpen } = state

  const [visible, setVisible] = useState(isChatOpen)
  const [closing, setClosing] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [draftChatWidth, setDraftChatWidth] = useState<number | null>(null)
  const wasOpenRef = useRef(isChatOpen)
  const draftWidthRef = useRef<number | null>(null)

  // Open: mount then trigger visible for animation
  useEffect(() => {
    if (isChatOpen) {
      setClosing(false)
      const frame = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(frame)
    }
  }, [isChatOpen])

  // Close: play exit animation then unmount
  useEffect(() => {
    if (!isChatOpen && wasOpenRef.current) {
      setClosing(true)
      const timer = setTimeout(() => {
        setVisible(false)
        setClosing(false)
      }, ANIM_DURATION)
      return () => clearTimeout(timer)
    }
    wasOpenRef.current = isChatOpen
  }, [isChatOpen])

  // Keep wasOpenRef in sync
  useEffect(() => {
    wasOpenRef.current = isChatOpen
  }, [isChatOpen])

  const handleToggle = useCallback(() => {
    setChatOpen(!isChatOpen)
  }, [isChatOpen, setChatOpen])

  // --- Resize ---
  const widthRef = useRef(chatWidth)
  widthRef.current = chatWidth

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const startX = e.clientX
      const startWidth = widthRef.current
      setIsResizing(true)
      draftWidthRef.current = startWidth
      setDraftChatWidth(startWidth)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMouseMove = (e: MouseEvent) => {
        const totalDelta = e.clientX - startX
        const maxWidth = window.innerWidth * MAX_CHAT_WIDTH_RATIO
        const nextWidth = Math.max(
          MIN_CHAT_WIDTH,
          Math.min(startWidth - totalDelta, maxWidth),
        )
        draftWidthRef.current = nextWidth
        setDraftChatWidth(nextWidth)
      }

      const handleMouseUp = () => {
        if (draftWidthRef.current !== null) {
          setChatWidth(draftWidthRef.current)
        }
        draftWidthRef.current = null
        setDraftChatWidth(null)
        setIsResizing(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [setChatWidth],
  )

  // Don't render the panel shell at all when fully closed
  if (!visible && !isChatOpen) {
    return (
      <button
        className="chat-panel-toggle"
        onClick={handleToggle}
        aria-label="Open chat"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
    )
  }

  const animClass = (closing || (!isChatOpen && visible))
    ? 'chat-closing'
    : (visible && isChatOpen)
      ? 'chat-open'
      : ''

  const shellClass = `chat-panel-shell ${animClass}${isResizing ? ' chat-resizing' : ''}`
  const panelWidth = draftChatWidth ?? chatWidth

  return (
    <div
      className={shellClass}
      style={{ '--chat-panel-width': `${panelWidth}px` } as React.CSSProperties}
    >
      <div className={`chat-resize-handle ${animClass}`} onMouseDown={handleMouseDown}>
        <button
          className="chat-panel-collapse"
          onClick={(e) => { e.stopPropagation(); handleToggle() }}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="Collapse chat"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>
      <div className="chat-panel-viewport">
        <div className={`chat-panel-inner ${animClass}`}>
          {children}
        </div>
      </div>
    </div>
  )
}
