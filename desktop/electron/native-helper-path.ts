import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const platformDir = process.platform === 'win32'
  ? 'win32'
  : process.platform === 'darwin'
    ? 'darwin'
    : process.platform

export const resolveNativeHelperPath = (baseName: string): string | null => {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const fileName = `${baseName}${ext}`
  const candidates = [
    // App bundle resources (preferred when running via dev wrapper or packaged app)
    path.join(process.resourcesPath, 'native', 'out', platformDir, fileName),
    // From source: electron/ → .. → native/out/
    path.join(__dirname, '..', 'native', 'out', platformDir, fileName),
    // From compiled: dist-electron/electron/ → ../.. → native/out/
    path.join(__dirname, '..', '..', 'native', 'out', platformDir, fileName),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}
