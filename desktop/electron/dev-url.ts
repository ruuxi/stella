import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEV_URL_FILE = path.resolve(__dirname, '../.vite-dev-url')
export function getDevServerUrl(): string {
  try {
    const url = fs.readFileSync(DEV_URL_FILE, 'utf-8').trim()
    if (url) return url
  } catch (error) {
    throw new Error(
      `Missing Vite dev URL marker at ${DEV_URL_FILE}. Start Electron via "bun run electron:dev" so the Vite plugin can write it.`,
      { cause: error },
    )
  }

  throw new Error(
    `Empty Vite dev URL marker at ${DEV_URL_FILE}. Restart "bun run electron:dev" to regenerate it.`,
  )
}
