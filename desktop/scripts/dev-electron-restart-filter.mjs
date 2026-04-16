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
    'runtime/kernel/agent-core/',
    'runtime/worker/',
    'runtime/kernel/cli/',
  ]
  if (sidecarOwnedPackagePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return false
  }

  const hostOwnedPackagePrefixes = [
    'runtime/client/',
    'runtime/protocol/',
    // Keep host reloads scoped to the runtime modules the Electron host
    // actually executes, either directly or through runtime-client.
    'runtime/discovery/browser-data',
    'runtime/kernel/convex-urls',
    'runtime/kernel/dev-projects/',
    'runtime/kernel/home/',
    'runtime/kernel/local-scheduler-service',
    'runtime/kernel/preferences/local-preferences',
    'runtime/kernel/shared/',
    'runtime/kernel/storage/',
    'runtime/kernel/tools/network-guards',
    'runtime/kernel/tools/stella-browser-bridge-config',
  ]
  if (hostOwnedPackagePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return true
  }

  if (
    !normalized.startsWith('electron/') &&
    !normalized.startsWith('desktop/electron/')
  ) {
    return false
  }

  return true
}
