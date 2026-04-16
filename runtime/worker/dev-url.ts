import fs from 'fs'
import path from 'path'

const FALLBACK_PORT = 57314

const resolveDevUrlFile = (): string | null => {
  const stellaRoot = process.env.STELLA_ROOT?.trim()
  if (!stellaRoot) return null
  return path.join(stellaRoot, 'desktop', '.vite-dev-url')
}

export function getDevServerUrl(): string {
  const devUrlFile = resolveDevUrlFile()
  if (devUrlFile) {
    try {
      const url = fs.readFileSync(devUrlFile, 'utf-8').trim()
      if (url) return url
    } catch {
      // Fall back when the dev URL file is missing during startup.
    }
  }
  return `http://localhost:${FALLBACK_PORT}`
}
