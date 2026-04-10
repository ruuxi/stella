import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEV_URL_FILE = path.resolve(__dirname, '../.vite-dev-url')
const FALLBACK_PORT = 57314
export function getDevServerUrl(): string {
  try {
    const url = fs.readFileSync(DEV_URL_FILE, 'utf-8').trim()
    if (url) return url
  } catch {
    // Fall back when the dev URL file is missing during startup.
  }

  return `http://localhost:${FALLBACK_PORT}`
}
