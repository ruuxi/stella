import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const launcherDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(launcherDir, '..')
const desktopDir = path.resolve(repoRoot, 'desktop')
const debugAppPath = path.resolve(
  launcherDir,
  'src-tauri',
  'target',
  'debug',
  'bundle',
  'macos',
  'Stella.app',
)

if (process.platform !== 'darwin') {
  console.error('[launcher:dev-app] This script is macOS-only.')
  process.exit(1)
}

if (!existsSync(desktopDir)) {
  console.error(`[launcher:dev-app] Missing desktop checkout at ${desktopDir}`)
  process.exit(1)
}

const buildResult = spawnSync(
  'bunx',
  ['tauri', 'build', '--debug', '--bundles', 'app', '--no-sign'],
  {
    cwd: launcherDir,
    stdio: 'inherit',
  },
)

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1)
}

if (!existsSync(debugAppPath)) {
  console.error(`[launcher:dev-app] Expected app bundle at ${debugAppPath}`)
  process.exit(1)
}

const openResult = spawnSync(
  'open',
  ['-n', debugAppPath, '--args', '--dev-path', desktopDir],
  {
    cwd: launcherDir,
    stdio: 'inherit',
  },
)

if (openResult.status !== 0) {
  process.exit(openResult.status ?? 1)
}
