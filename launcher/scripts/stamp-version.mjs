import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const launcherDir = path.resolve(scriptDir, '..')

const rawVersion = process.argv[2]?.trim() ?? ''
const normalizedVersion = rawVersion
  .replace(/^desktop-v/i, '')
  .replace(/^launcher-v/i, '')
  .replace(/^v/i, '')

if (!normalizedVersion) {
  console.error('[launcher:stamp-version] Missing version argument.')
  process.exit(1)
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalizedVersion)) {
  console.error(
    `[launcher:stamp-version] Invalid version "${rawVersion}". Expected semver-like value.`,
  )
  process.exit(1)
}

const updateJsonVersion = (relativePath, indent) => {
  const absolutePath = path.join(launcherDir, relativePath)
  const data = JSON.parse(readFileSync(absolutePath, 'utf8'))
  data.version = normalizedVersion
  writeFileSync(absolutePath, `${JSON.stringify(data, null, indent)}\n`, 'utf8')
}

const updateCargoTomlVersion = (relativePath) => {
  const absolutePath = path.join(launcherDir, relativePath)
  const existing = readFileSync(absolutePath, 'utf8')
  const next = existing.replace(
    /^version = ".*"$/m,
    `version = "${normalizedVersion}"`,
  )

  if (next === existing) {
    console.error(
      `[launcher:stamp-version] Could not find version field in ${relativePath}.`,
    )
    process.exit(1)
  }

  writeFileSync(absolutePath, next, 'utf8')
}

updateJsonVersion('package.json', '\t')
updateJsonVersion(path.join('src-tauri', 'tauri.conf.json'), 2)
updateCargoTomlVersion(path.join('src-tauri', 'Cargo.toml'))

console.log(`[launcher:stamp-version] Stamped launcher version ${normalizedVersion}`)
