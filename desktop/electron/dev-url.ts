import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export function getDevServerUrl(): string {
  const candidates = [
    process.env.STELLA_ROOT
      ? path.join(process.env.STELLA_ROOT, 'desktop', '.vite-dev-url')
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
  return url
}
