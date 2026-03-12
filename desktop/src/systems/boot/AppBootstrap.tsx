import { useConversationBootstrap } from './use-conversation-bootstrap'
import { useSelfModTaintMonitor } from './use-self-mod-taint-monitor'

export const AppBootstrap = () => {
  useConversationBootstrap()
  useSelfModTaintMonitor()

  return null
}


