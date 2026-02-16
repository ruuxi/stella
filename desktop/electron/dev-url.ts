import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEV_URL_FILE = path.resolve(__dirname, '../.vite-dev-url')
const FALLBACK_PORT = 5714

/**
 * Read the dev server URL written by the Vite plugin.
 * Falls back to localhost:5714 if the file doesn't exist.
 */
export function getDevServerUrl(): string {
  try {
    const url = fs.readFileSync(DEV_URL_FILE, 'utf-8').trim()
    if (url) return url
  } catch {}
  return `http://localhost:${FALLBACK_PORT}`
}
