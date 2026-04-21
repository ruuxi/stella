import { createContext } from 'react'
import type { useFullShellChat } from '@/shell/use-full-shell-chat'

/**
 * Internal Context object backing `ChatRuntimeProvider` / `useChatRuntime`.
 *
 * This file is intentionally hook-only / value-only — no React components are
 * exported from here. Splitting the Context object away from the Provider
 * component keeps both the Provider file and the hook file Fast-Refresh
 * eligible (`react-refresh/only-export-components`). Without this split, every
 * save to the Provider file rebuilt the Context, which in turn made existing
 * consumers throw "must be used within ChatRuntimeProvider" until the next
 * full reload.
 */
export type ChatRuntime = ReturnType<typeof useFullShellChat>

export const ChatRuntimeContext = createContext<ChatRuntime | null>(null)
