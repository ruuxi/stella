import fs from 'fs'
import path from 'path'

const __dirname = import.meta.dirname

// The dev server URL is fixed for the process lifetime, but this thunk is
// re-invoked on every window load. Cache the resolved URL so we don't re-probe
// candidate paths + re-read the .vite-dev-url file each time.
let cachedDevUrl: string | null = null

export function getDevServerUrl(): string {
  if (cachedDevUrl) {
    return cachedDevUrl
  }
  const candidates = [
    process.env.STELLA_APP_DIR
      ? path.join(process.env.STELLA_APP_DIR, 'desktop', '.vite-dev-url')
      : null,
    path.resolve(__dirname, '../../../../desktop/.vite-dev-url'),
    path.resolve(__dirname, '../.vite-dev-url'),
    path.resolve(process.cwd(), 'desktop', '.vite-dev-url'),
    path.resolve(process.cwd(), '.vite-dev-url'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  const devUrlFile = candidates.find((candidate) => fs.existsSync(candidate))
    ?? candidates[0]
  const url = fs.readFileSync(devUrlFile, 'utf-8').trim()
  if (!url) {
    throw new Error(`Vite dev server URL file is empty: ${devUrlFile}`)
  }
  // Cache only after validation so a transient empty/partial file is never cached.
  cachedDevUrl = url
  return url
}
