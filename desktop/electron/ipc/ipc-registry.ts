import { registerAgentHandlers } from './handlers/agent-handlers.js'
import { registerBrowserHandlers } from './handlers/browser-handlers.js'
import { registerCaptureHandlers } from './handlers/capture-handlers.js'
import { registerMiniBridgeHandlers } from './handlers/mini-bridge-handlers.js'
import { registerStoreHandlers } from './handlers/store-handlers.js'
import { registerSystemHandlers } from './handlers/system-handlers.js'
import { registerUiHandlers } from './handlers/ui-handlers.js'
import { registerVoiceHandlers } from './handlers/voice-handlers.js'

type RegistryOptions = {
  ui: Parameters<typeof registerUiHandlers>[0]
  capture: Parameters<typeof registerCaptureHandlers>[0]
  system: Parameters<typeof registerSystemHandlers>[0]
  browser: Parameters<typeof registerBrowserHandlers>[0]
  agent: Parameters<typeof registerAgentHandlers>[0]
  miniBridge: Parameters<typeof registerMiniBridgeHandlers>[0]
  store: Parameters<typeof registerStoreHandlers>[0]
  voice: Parameters<typeof registerVoiceHandlers>[0]
}

export const registerAllIpcHandlers = (options: RegistryOptions) => {
  registerUiHandlers(options.ui)
  registerCaptureHandlers(options.capture)
  registerSystemHandlers(options.system)
  registerBrowserHandlers(options.browser)
  registerAgentHandlers(options.agent)
  registerMiniBridgeHandlers(options.miniBridge)
  registerStoreHandlers(options.store)
  registerVoiceHandlers(options.voice)
}
