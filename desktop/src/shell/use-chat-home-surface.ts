import { useCallback, useEffect, useRef, useState } from 'react'
import { useIdleHomeVisibility } from '@/app/chat/hooks/use-idle-home-visibility'
import { STELLA_SHOW_HOME_EVENT } from '@/shared/lib/stella-orb-chat'

/** Set when navigating away from chat; cleared on full app restart (new session). */
const SESSION_LEFT_CHAT_KEY = 'stella_left_chat_once'
const CHAT_HOME_SURFACE_STORAGE_KEY = 'stella.chatHomeSurface'

type ChatHomeSurface = 'home' | 'chat'

function readPersistedChatHomeSurface(): ChatHomeSurface | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(CHAT_HOME_SURFACE_STORAGE_KEY)
    return raw === 'home' || raw === 'chat' ? raw : null
  } catch {
    return null
  }
}

function writePersistedChatHomeSurface(surface: ChatHomeSurface): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(CHAT_HOME_SURFACE_STORAGE_KEY, surface)
  } catch {
    // Storage is best-effort; the chat route itself still restores normally.
  }
}

type UseChatHomeSurfaceOptions = {
  isOnChatRoute: boolean
  hasMessages: boolean
  isStreaming: boolean
  activeConversationId: string | null
}

type UseChatHomeSurfaceResult = {
  /** True when the home overlay should be visible above the chat surface. */
  showHomeContent: boolean
  /** Mark the user as actively interacting with chat (collapses home). */
  enterChatSurfaceForInteraction: () => void
  /** Reset the idle timer (e.g. after the user clicks a suggestion). */
  resetIdleTimer: () => void
  /** Explicitly dismiss home (the "Back to chat" link). */
  dismissHome: () => void
  /** Explicitly bring home back. */
  showHome: () => void
}

/**
 * Owns the chat / home toggle for the full-shell chat surface.
 *
 * Three persistence layers stack here:
 *
 * 1. `SESSION_LEFT_CHAT_KEY` (sessionStorage) — once the user has navigated
 *    away from `/chat` once in this session, we stop forcing the home
 *    overlay just because the conversation is empty (the
 *    `firstStintOnChat` guard).
 * 2. `CHAT_HOME_SURFACE_STORAGE_KEY` (localStorage) — explicit "is the
 *    home overlay or the chat surface the canonical view right now"
 *    sticky preference. Survives reloads.
 * 3. The idle home timer from `useIdleHomeVisibility` — re-shows home
 *    after a long idle window even if the user previously dismissed it.
 *
 * An explicit dismiss (`dismissHome`) overrides the default
 * "no messages → show home" behavior; otherwise empty conversations
 * could never escape the home overlay. The dismiss is cleared on real
 * interaction or on switching to a different conversation.
 */
export function useChatHomeSurface({
  isOnChatRoute,
  hasMessages,
  isStreaming,
  activeConversationId,
}: UseChatHomeSurfaceOptions): UseChatHomeSurfaceResult {
  const [leftChatOnce, setLeftChatOnce] = useState(() => {
    if (typeof sessionStorage === 'undefined') return false
    return sessionStorage.getItem(SESSION_LEFT_CHAT_KEY) === '1'
  })
  const [
    hasInteractedWithChatThisSession,
    setHasInteractedWithChatThisSession,
  ] = useState(false)
  const [isHomeDismissed, setIsHomeDismissed] = useState(
    () => readPersistedChatHomeSurface() === 'chat',
  )
  const prevOnChatRouteRef = useRef(isOnChatRoute)
  const prevConversationIdRef = useRef(activeConversationId)

  const { showHomeContent: idleBasedHome, resetIdleTimer, forceShowHome } =
    useIdleHomeVisibility({ hasMessages, isStreaming })

  const firstStintOnChat = !leftChatOnce && isOnChatRoute
  const baseShowHomeContent = firstStintOnChat
    ? !hasMessages || !hasInteractedWithChatThisSession || idleBasedHome
    : idleBasedHome
  const showHomeContent = isHomeDismissed ? false : baseShowHomeContent

  useEffect(() => {
    if (prevConversationIdRef.current === activeConversationId) return
    const hadConversation = Boolean(prevConversationIdRef.current)
    prevConversationIdRef.current = activeConversationId
    if (hadConversation) {
      queueMicrotask(() => {
        setIsHomeDismissed(false)
      })
    }
  }, [activeConversationId])

  useEffect(() => {
    if (!isOnChatRoute) return
    writePersistedChatHomeSurface(showHomeContent ? 'home' : 'chat')
  }, [isOnChatRoute, showHomeContent])

  useEffect(() => {
    if (prevOnChatRouteRef.current && !isOnChatRoute) {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_LEFT_CHAT_KEY, '1')
      }
      queueMicrotask(() => {
        setLeftChatOnce(true)
      })
    }
    prevOnChatRouteRef.current = isOnChatRoute
  }, [isOnChatRoute])

  const enterChatSurfaceForInteraction = useCallback(() => {
    setHasInteractedWithChatThisSession(true)
    setIsHomeDismissed(true)
    writePersistedChatHomeSurface('chat')
  }, [])

  const dismissHome = useCallback(() => {
    setIsHomeDismissed(true)
    writePersistedChatHomeSurface('chat')
  }, [])

  const showHome = useCallback(() => {
    setIsHomeDismissed(false)
    writePersistedChatHomeSurface('home')
    forceShowHome()
  }, [forceShowHome])

  useEffect(() => {
    const handler = () => {
      setIsHomeDismissed(false)
      writePersistedChatHomeSurface('home')
      forceShowHome()
    }
    window.addEventListener(STELLA_SHOW_HOME_EVENT, handler)
    return () => window.removeEventListener(STELLA_SHOW_HOME_EVENT, handler)
  }, [forceShowHome])

  return {
    showHomeContent,
    enterChatSurfaceForInteraction,
    resetIdleTimer,
    dismissHome,
    showHome,
  }
}
