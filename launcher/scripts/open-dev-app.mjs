import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const launcherDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(launcherDir, '..')
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

if (!existsSync(path.resolve(repoRoot, 'desktop'))) {
  console.error(`[launcher:dev-app] Missing desktop checkout at ${path.resolve(repoRoot, 'desktop')}`)
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
  ['-n', debugAppPath, '--args', '--dev-path', repoRoot],
  {
    cwd: launcherDir,
    stdio: 'inherit',
  },
)

if (openResult.status !== 0) {
  process.exit(openResult.status ?? 1)
}
