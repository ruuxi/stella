import path from 'node:path'

export const shouldRestartElectronForBuildPath = (filename) => {
  if (typeof filename !== 'string') {
    return false
  }

  const normalized = filename.split(path.sep).join('/')
  if (!normalized.endsWith('.js') || normalized.endsWith('.d.ts')) {
    return false
  }

  if (normalized.startsWith('packages/stella-runtime-client/')) {
    return true
  }
  if (normalized.startsWith('packages/stella-runtime-protocol/')) {
    return true
  }
  if (!normalized.startsWith('electron/')) {
    return false
  }

  const electronPath = normalized.slice('electron/'.length)
  const workerOwnedPrefixes = [
    'self-mod/',
    'storage/',
  ]
  if (workerOwnedPrefixes.some((prefix) => electronPath.startsWith(prefix))) {
    return false
  }
  if (
    electronPath === 'services/local-scheduler-service.js' ||
    electronPath === 'system/device.js'
  ) {
    return false
  }

  // `electron/core/runtime/**` is still shared with Electron main via modules like
  // overlay streaming, browser handlers, preferences, and credential storage.
  // Restart Electron for the whole tree so dev behavior matches a clean boot.
  return true
}
