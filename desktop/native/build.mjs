import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: __dirname,
    stdio: 'inherit',
    windowsHide: true,
  })

  if (typeof result.status === 'number') {
    process.exit(result.status)
  }
  process.exit(1)
}

switch (process.platform) {
  case 'win32':
    run('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', 'build.ps1'])
    break
  case 'darwin':
    run('bash', ['build.sh'])
    break
  default:
    console.log(`No native helper build configured for ${process.platform}.`)
    process.exit(0)
}
