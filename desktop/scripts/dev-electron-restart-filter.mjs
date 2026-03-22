import path from 'node:path'

export const shouldRestartElectronForBuildPath = (filename) => {
  if (typeof filename !== 'string') {
    return false
  }

  const normalized = filename.split(path.sep).join('/')
  if (!normalized.endsWith('.js') || normalized.endsWith('.d.ts')) {
    return false
  }

  const sidecarOwnedPackagePrefixes = [
    'packages/runtime-kernel/agent-core/',
    'packages/runtime-worker/',
    'packages/runtime-capabilities/',
    'packages/runtime-kernel/cli/',
    'resources/bundled-commands/',
  ]
  if (sidecarOwnedPackagePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return false
  }

  const hostOwnedPackagePrefixes = [
    'packages/runtime-client/',
    'packages/runtime-protocol/',
    'packages/boundary-contracts/',
    // Electron main imports runtime modules from these extracted packages
    // directly. Keep dev reloads correct by restarting the host for any
    // change under those package trees instead of risking stale main-process
    // code.
    'packages/ai/',
    'packages/runtime-kernel/',
    'packages/runtime-kernel/home/',
    'packages/runtime-discovery/',
    'packages/runtime-kernel/dev-projects/',
    'packages/runtime-kernel/self-mod/',
  ]
  if (hostOwnedPackagePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return true
  }

  if (!normalized.startsWith('electron/')) {
    return false
  }

  return true
}
