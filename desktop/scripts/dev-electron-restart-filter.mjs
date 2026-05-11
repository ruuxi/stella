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
    'runtime/host/',
    'runtime/protocol/',
    // Keep host reloads scoped to the runtime modules the Electron host
    // actually executes, either directly or through the runtime host adapter.
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

  // Webview preloads load with the webview, not with Electron main, so
  // they do NOT require an Electron restart -- they apply on the next
  // webview navigation/reload. The store webview's preload was the only
  // thing left that triggered a spurious restart on agent self-mod runs:
  // esbuild's bundler context for it occasionally re-emits with different
  // bytes (likely from tsconfig include-glob FSEvents fan-out around
  // routeTree regeneration) even though no real code in its tiny import
  // graph changed. Exclude from restart-relevance so a webview-only
  // re-bundle never tears down the main process the user's chat is in.
  const webviewPreloadOutputs = new Set([
    'desktop/electron/store-web-preload.js',
    'electron/store-web-preload.js',
  ])
  if (webviewPreloadOutputs.has(normalized)) {
    return false
  }

  return true
}
