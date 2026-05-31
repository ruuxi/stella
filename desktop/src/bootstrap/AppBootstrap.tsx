import { useConversationBootstrap } from './use-conversation-bootstrap'
import { useStellaBrowserBridgeToast } from './use-stella-browser-bridge-toast'

export const AppBootstrap = () => {
  // Keep boot light; self-mod taint polling is mounted from worker-backed surfaces
  // instead of global startup so we don't wake the worker immediately.
  useConversationBootstrap()
  useStellaBrowserBridgeToast()

  return null
}
