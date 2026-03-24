import { useConversationBootstrap } from './use-conversation-bootstrap'
import { useSelfModTaintMonitor } from './use-self-mod-taint-monitor'
import { useStellaBrowserBridgeToast } from './use-stella-browser-bridge-toast'

export const AppBootstrap = () => {
  useConversationBootstrap()
  useSelfModTaintMonitor()
  useStellaBrowserBridgeToast()

  return null
}

