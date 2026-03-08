/**
 * ChatPanel: Collapsible right panel that wraps the chat interface.
 * Provides resize handle, open/close animation, and collapse toggle.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import {
  MAX_CHAT_WIDTH_RATIO,
  MIN_CHAT_WIDTH,
  useWorkspace,
} from '@/providers/workspace-state'
import './chat-panel.css'

const ANIM_DURATION = 350 // ms, matches CSS chat-slide-out duration
const OPEN_CHAT_ICON = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 18l-6-6 6-6" />
  </svg>
)
const COLLAPSE_CHAT_ICON = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 18l6-6-6-6" />
  </svg>
)

export function ChatPanel({ children }: { children: ReactNode }) {
  const { state, setChatWidth, setChatOpen } = useWorkspace()
  const { chatWidth, isChatOpen } = state

  const [visible, setVisible] = useState(isChatOpen)
  const [closing, setClosing] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [draftChatWidth, setDraftChatWidth] = useState<number | null>(null)
  const wasOpenRef = useRef(isChatOpen)
  const isChatOpenRef = useRef(isChatOpen)
  const draftWidthRef = useRef<number | null>(null)
  const widthRef = useRef(chatWidth)
  const resizeListenersRef = useRef<{
    move: (event: MouseEvent) => void
    up: () => void
  } | null>(null)

  useEffect(() => {
    const wasOpen = wasOpenRef.current
    wasOpenRef.current = isChatOpen

    if (isChatOpen) {
      const frame = requestAnimationFrame(() => {
        setClosing(false)
        setVisible(true)
      })
      return () => cancelAnimationFrame(frame)
    }

    if (wasOpen) {
      const frame = requestAnimationFrame(() => {
        setClosing(true)
      })
      const timer = setTimeout(() => {
        setVisible(false)
        setClosing(false)
      }, ANIM_DURATION)
      return () => {
        cancelAnimationFrame(frame)
        clearTimeout(timer)
      }
    }
  }, [isChatOpen])

  const teardownResizeListeners = useCallback(() => {
    const listeners = resizeListenersRef.current
    if (!listeners) return
    document.removeEventListener('mousemove', listeners.move)
    document.removeEventListener('mouseup', listeners.up)
    resizeListenersRef.current = null
  }, [])

  const resetResizeUi = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const finishResize = useCallback(
    (commit: boolean) => {
      if (commit && draftWidthRef.current !== null) {
        setChatWidth(draftWidthRef.current)
      }
      draftWidthRef.current = null
      setDraftChatWidth(null)
      setIsResizing(false)
      resetResizeUi()
      teardownResizeListeners()
    },
    [resetResizeUi, setChatWidth, teardownResizeListeners],
  )

  useEffect(() => {
    return () => {
      draftWidthRef.current = null
      resetResizeUi()
      teardownResizeListeners()
    }
  }, [resetResizeUi, teardownResizeListeners])

  useEffect(() => {
    isChatOpenRef.current = isChatOpen
    widthRef.current = chatWidth
  }, [chatWidth, isChatOpen])

  const handleToggle = useCallback(() => {
    setChatOpen(!isChatOpenRef.current)
  }, [setChatOpen])

  // --- Resize ---
  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      teardownResizeListeners()
      resetResizeUi()

      const startX = event.clientX
      const startWidth = widthRef.current
      setIsResizing(true)
      draftWidthRef.current = startWidth
      setDraftChatWidth(startWidth)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const totalDelta = moveEvent.clientX - startX
        const maxWidth = window.innerWidth * MAX_CHAT_WIDTH_RATIO
        const nextWidth = Math.max(
          MIN_CHAT_WIDTH,
          Math.min(startWidth - totalDelta, maxWidth),
        )
        draftWidthRef.current = nextWidth
        setDraftChatWidth(nextWidth)
      }

      const handleMouseUp = () => {
        finishResize(true)
      }

      resizeListenersRef.current = { move: handleMouseMove, up: handleMouseUp }
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [finishResize, resetResizeUi, teardownResizeListeners],
  )

  const handleCollapseClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      handleToggle()
    },
    [handleToggle],
  )

  const handleCollapseMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
    },
    [],
  )

  // Don't render the panel shell at all when fully closed
  if (!visible && !isChatOpen) {
    return (
      <button
        className="chat-panel-toggle"
        onClick={handleToggle}
        aria-label="Open chat"
      >
        {OPEN_CHAT_ICON}
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
      style={{ '--chat-panel-width': `${panelWidth}px` } as CSSProperties}
    >
      <div className={`chat-resize-handle ${animClass}`} onMouseDown={handleMouseDown}>
        <button
          className="chat-panel-collapse"
          onClick={handleCollapseClick}
          onMouseDown={handleCollapseMouseDown}
          aria-label="Collapse chat"
        >
          {COLLAPSE_CHAT_ICON}
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

