import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEV_URL_FILE = path.resolve(__dirname, '../.vite-dev-url')
export function getDevServerUrl(): string {
  const url = fs.readFileSync(DEV_URL_FILE, 'utf-8').trim()
  if (!url) {
    throw new Error(`Vite dev server URL file is empty: ${DEV_URL_FILE}`)
  }
  return url
}
