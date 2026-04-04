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
    // Keep host reloads scoped to the runtime modules the Electron host
    // actually executes, either directly or through runtime-client.
    'packages/runtime-discovery/browser-data',
    'packages/runtime-kernel/convex-urls',
    'packages/runtime-kernel/dev-projects/',
    'packages/runtime-kernel/home/',
    'packages/runtime-kernel/local-scheduler-service',
    'packages/runtime-kernel/preferences/local-preferences',
    'packages/runtime-kernel/shared/',
    'packages/runtime-kernel/storage/',
    'packages/runtime-kernel/tools/network-guards',
    'packages/runtime-kernel/tools/stella-browser-bridge-config',
  ]
  if (hostOwnedPackagePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return true
  }

  if (!normalized.startsWith('electron/')) {
    return false
  }

  return true
}
