#!/usr/bin/env node
// Downloads the platform-relevant native helpers tarball from R2 and extracts
// it into desktop/native/out/<platform>/. Mirrors the launcher's install-time
// step so dev contributors and the install-update agent can refresh native
// helpers without rebuilding locally.
//
// Usage:
//   bun run native:download [--manifest-url <url>] [--platform <key>] [--force]
//
// Defaults to the canonical R2 manifest URL and the host platform. Pass --force
// to re-download even when binaries already look present.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const DEFAULT_MANIFEST_URL =
  process.env.STELLA_NATIVE_HELPERS_MANIFEST_URL ??
  'https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/native-helpers/current.json'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

const args = process.argv.slice(2)
let manifestUrl = DEFAULT_MANIFEST_URL
let platformOverride = ''
let force = false
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--manifest-url' && i + 1 < args.length) {
    manifestUrl = args[++i]
  } else if (arg === '--platform' && i + 1 < args.length) {
    platformOverride = args[++i]
  } else if (arg === '--force') {
    force = true
  } else if (arg === '--help' || arg === '-h') {
    process.stdout.write(
      'Usage: bun run native:download [--manifest-url <url>] [--platform <key>] [--force]\n'
    )
    process.exit(0)
  } else {
    process.stderr.write(`Unknown argument: ${arg}\n`)
    process.exit(1)
  }
}

const platformKey =
  platformOverride ||
  (process.platform === 'win32' && process.arch === 'x64'
    ? 'win-x64'
    : process.platform === 'darwin' && process.arch === 'arm64'
      ? 'darwin-arm64'
      : process.platform === 'darwin' && process.arch === 'x64'
        ? 'darwin-x64'
        : '')

if (!platformKey) {
  process.stderr.write(
    `Unsupported platform/arch combo: ${process.platform}/${process.arch}. Pass --platform to override.\n`
  )
  process.exit(1)
}

const platformDir =
  platformKey === 'win-x64'
    ? 'win32'
    : platformKey.startsWith('darwin-')
      ? 'darwin'
      : platformKey.startsWith('linux-')
        ? 'linux'
        : null
if (!platformDir) {
  process.stderr.write(`Cannot map platform key ${platformKey} to a native/out subdirectory.\n`)
  process.exit(1)
}

const outDir = path.join(repoRoot, 'desktop', 'native', 'out', platformDir)
const sentinel = path.join(outDir, platformDir === 'win32' ? 'window_info.exe' : 'window_info')
if (!force && existsSync(sentinel)) {
  process.stdout.write(
    `Native helpers for ${platformKey} already look present at ${outDir} (pass --force to refresh).\n`
  )
  process.exit(0)
}

process.stdout.write(`Resolving native helpers manifest: ${manifestUrl}\n`)
const manifestResp = await fetch(manifestUrl, { headers: { 'User-Agent': 'stella-native-download' } })
if (!manifestResp.ok) {
  process.stderr.write(`Manifest request failed: HTTP ${manifestResp.status}\n`)
  process.exit(1)
}
const manifest = await manifestResp.json()
if (manifest.schemaVersion !== 1) {
  process.stderr.write(`Unsupported native helpers manifest schema: ${manifest.schemaVersion}\n`)
  process.exit(1)
}
const asset = manifest.assets?.[platformKey]
if (!asset) {
  process.stderr.write(`Manifest has no asset for ${platformKey}.\n`)
  process.exit(1)
}

process.stdout.write(`Downloading native helpers for ${platformKey} from ${asset.url}\n`)
const archiveResp = await fetch(asset.url, { headers: { 'User-Agent': 'stella-native-download' } })
if (!archiveResp.ok || !archiveResp.body) {
  process.stderr.write(`Download failed: HTTP ${archiveResp.status}\n`)
  process.exit(1)
}

const tmpArchive = path.join(repoRoot, '.stella-native-helpers-download.tar.zst')
const hash = createHash('sha256')
const writeStream = createWriteStream(tmpArchive)
const reader = archiveResp.body.getReader()
let downloaded = 0
const totalBytes = Number(archiveResp.headers.get('content-length') ?? asset.size ?? 0) || 0
while (true) {
  const { value, done } = await reader.read()
  if (done) break
  if (!value) continue
  downloaded += value.byteLength
  hash.update(value)
  if (!writeStream.write(value)) {
    await new Promise((resolve) => writeStream.once('drain', resolve))
  }
  if (totalBytes > 0 && downloaded % (1024 * 1024) < value.byteLength) {
    process.stdout.write(`  ${(downloaded / 1024 / 1024).toFixed(1)} MiB / ${(totalBytes / 1024 / 1024).toFixed(1)} MiB\r`)
  }
}
await new Promise((resolve, reject) => {
  writeStream.end((err) => (err ? reject(err) : resolve(undefined)))
})
process.stdout.write('\n')

const actualSha = hash.digest('hex')
if (actualSha.toLowerCase() !== String(asset.sha256).toLowerCase()) {
  rmSync(tmpArchive, { force: true })
  process.stderr.write(
    `Checksum mismatch for ${platformKey}: expected ${asset.sha256}, got ${actualSha}\n`
  )
  process.exit(1)
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

process.stdout.write(`Extracting into ${outDir}\n`)
const tarResult = spawnSync('tar', ['--zstd', '-xf', tmpArchive, '-C', outDir], {
  stdio: 'inherit',
})
if (tarResult.status !== 0) {
  process.stderr.write('tar extraction failed.\n')
  process.exit(tarResult.status ?? 1)
}
rmSync(tmpArchive, { force: true })

if (process.platform !== 'win32') {
  const setExec = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        setExec(full)
      } else if (entry.isFile()) {
        try {
          chmodSync(full, statSync(full).mode | 0o111)
        } catch {}
      }
    }
  }
  setExec(outDir)
}

process.stdout.write(
  `Native helpers for ${platformKey} installed (sha=${manifest.sha ?? 'unknown'}).\n`
)
