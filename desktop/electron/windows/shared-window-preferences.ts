import type { BrowserWindowConstructorOptions } from 'electron'

type SharedWebPreferencesOptions = {
  preloadPath: string
  sessionPartition: string
  backgroundThrottling?: boolean
}

export const createSharedWebPreferences = ({
  preloadPath,
  sessionPartition,
  backgroundThrottling,
}: SharedWebPreferencesOptions): NonNullable<BrowserWindowConstructorOptions['webPreferences']> => ({
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  partition: sessionPartition,
  ...(backgroundThrottling === undefined ? {} : { backgroundThrottling }),
})
