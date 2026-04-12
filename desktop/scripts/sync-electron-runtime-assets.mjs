import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path, { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const electronRuntimeAssets = [
  {
    sourceRelativePath: 'runtime/kernel/tools/execute-typescript-runner.mjs',
    destinationRelativePath: 'runtime/kernel/tools/execute-typescript-runner.mjs',
  },
]

export const syncElectronRuntimeAssets = ({ projectDir = process.cwd() } = {}) => {
  const copied = []

  for (const asset of electronRuntimeAssets) {
    const sourcePath = resolve(projectDir, asset.sourceRelativePath)
    const destinationPath = resolve(projectDir, 'dist-electron', asset.destinationRelativePath)

    if (!existsSync(sourcePath)) {
      throw new Error(`Missing runtime asset: ${asset.sourceRelativePath}`)
    }

    mkdirSync(dirname(destinationPath), { recursive: true })

    const sourceBuffer = readFileSync(sourcePath)
    const destinationBuffer = existsSync(destinationPath) ? readFileSync(destinationPath) : null
    if (destinationBuffer && Buffer.compare(sourceBuffer, destinationBuffer) === 0) {
      continue
    }

    copyFileSync(sourcePath, destinationPath)
    copied.push(path.relative(projectDir, destinationPath))
  }

  return copied
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  const copied = syncElectronRuntimeAssets()
  if (copied.length > 0) {
    console.log(`[electron-assets] Synced ${copied.join(', ')}`)
  }
}
