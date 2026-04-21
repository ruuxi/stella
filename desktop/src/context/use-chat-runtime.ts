import { useContext } from 'react'
import {
  ChatRuntimeContext,
  type ChatRuntime,
} from '@/context/chat-runtime-context'

/**
 * Read the hoisted chat runtime from the nearest `ChatRuntimeProvider`.
 * Throws if used outside the provider so misuse is loud rather than silent.
 *
 * Lives in its own file (no component exports) so React Fast Refresh
 * doesn't HMR-invalidate the Context module when the hook changes.
 */
export function useChatRuntime(): ChatRuntime {
  const ctx = useContext(ChatRuntimeContext)
  if (!ctx) {
    throw new Error('useChatRuntime must be used within ChatRuntimeProvider')
  }
  return ctx
}
