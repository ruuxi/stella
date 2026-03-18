#!/usr/bin/env node
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { spawnSync } from 'child_process'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const markerFileName = '.stella-bindings.json'
const ignoredDirs = new Set([
  '.git',
  '.idea',
  '.next',
  '.turbo',
  '.vscode',
  'coverage',
  'dist',
  'node_modules',
  'target',
])

const defaultDatabase = process.env.VITE_SPACETIMEDB_MODULE ?? 'stella-w08uu'
const defaultOutDir = resolve(
  repoRoot,
  'src',
  'features',
  'games',
  'generated-bindings',
)
const defaultModulePath = resolve(
  repoRoot,
  process.env.STELLA_SPACETIME_MODULE_PATH ?? '../spacetimedb',
)

const usage = `Usage:
  node scripts/generate-game-bindings.mjs [options]

Options:
  --database <name>      SpacetimeDB database/module name
  --out-dir <path>       Output directory for generated bindings
  --module-path <path>   Local module source path passed to spacetime generate
  --force                Regenerate even if cached bindings are up to date
  --help                 Show this message
`

function resolvePathArg(value) {
  return isAbsolute(value) ? value : resolve(repoRoot, value)
}

function parseArgs(argv) {
  let database = defaultDatabase
  let outDir = defaultOutDir
  let modulePath = defaultModulePath
  let force = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--database' && argv[i + 1]) {
      database = argv[i + 1]
      i += 1
      continue
    }
    if (arg === '--out-dir' && argv[i + 1]) {
      outDir = resolvePathArg(argv[i + 1])
      i += 1
      continue
    }
    if (arg === '--module-path' && argv[i + 1]) {
      modulePath = resolvePathArg(argv[i + 1])
      i += 1
      continue
    }
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--help') {
      console.log(usage)
      process.exit(0)
    }

    console.error(`Unknown argument: ${arg}`)
    console.error(usage)
    process.exit(1)
  }

  return {
    database,
    outDir,
    modulePath,
    force,
  }
}

function updateFingerprint(hash, rootDir, currentPath) {
  const entries = readdirSync(currentPath, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )

  for (const entry of entries) {
    if (entry.name === markerFileName) {
      continue
    }

    const absolutePath = join(currentPath, entry.name)
    const relativePath = relative(rootDir, absolutePath)

    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) {
        continue
      }

      hash.update(`dir:${relativePath}\n`)
      updateFingerprint(hash, rootDir, absolutePath)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    hash.update(`file:${relativePath}\n`)
    hash.update(readFileSync(absolutePath))
    hash.update('\n')
  }
}

function computeModuleFingerprint(modulePath) {
  if (!existsSync(modulePath)) {
    throw new Error(`SpacetimeDB module path not found: ${modulePath}`)
  }

  const stats = statSync(modulePath)
  const hash = createHash('sha256')

  if (stats.isDirectory()) {
    updateFingerprint(hash, modulePath, modulePath)
  } else if (stats.isFile()) {
    hash.update(readFileSync(modulePath))
  } else {
    throw new Error(`Unsupported SpacetimeDB module path: ${modulePath}`)
  }

  return hash.digest('hex')
}

function readMarker(markerPath) {
  if (!existsSync(markerPath)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return null
  }
}

function runSpacetime(args) {
  return spawnSync('spacetime', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function toRepoRelative(pathValue) {
  return relative(repoRoot, pathValue).replaceAll('\\', '/') || '.'
}

const { database, outDir, modulePath, force } = parseArgs(process.argv.slice(2))
const markerPath = join(outDir, markerFileName)
const tempOutDir = `${outDir}.tmp-${process.pid}-${Date.now()}`
const cleanupTempOutDir = () => {
  rmSync(tempOutDir, { recursive: true, force: true })
}

const outDirHasBindings = existsSync(join(outDir, 'index.ts'))

if (!existsSync(modulePath)) {
  if (outDirHasBindings) {
    console.log(
      `SpacetimeDB module not found at ${modulePath} — using committed bindings in ${toRepoRelative(outDir)}.`,
    )
    process.exit(0)
  }
  console.error(
    `SpacetimeDB module not found at ${modulePath} and no bindings exist in ${toRepoRelative(outDir)}.`,
  )
  process.exit(1)
}

let moduleFingerprint
try {
  moduleFingerprint = computeModuleFingerprint(modulePath)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const currentMarker = readMarker(markerPath)

if (
  !force
  && currentMarker?.database === database
  && currentMarker?.modulePath === toRepoRelative(modulePath)
  && currentMarker?.moduleFingerprint === moduleFingerprint
  && outDirHasBindings
) {
  console.log(
    `SpacetimeDB bindings are up to date in ${toRepoRelative(outDir)}.`,
  )
  process.exit(0)
}

// Verify the spacetime CLI is available before attempting to regenerate.
const spacetimeCheck = spawnSync('spacetime', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
if (spacetimeCheck.error) {
  if (outDirHasBindings) {
    console.log(
      `spacetime CLI not found — using committed bindings in ${toRepoRelative(outDir)}.`,
    )
    process.exit(0)
  }
  console.error(
    'spacetime CLI not found and no bindings exist. Install it from https://spacetimedb.com',
  )
  process.exit(1)
}

cleanupTempOutDir()
mkdirSync(tempOutDir, { recursive: true })

const outDirArg = toRepoRelative(tempOutDir)
const modulePathArg = relative(repoRoot, modulePath).replaceAll('\\', '/')
const generateResult = runSpacetime([
  'generate',
  database,
  '--lang',
  'typescript',
  '--out-dir',
  outDirArg,
  '--module-path',
  modulePathArg,
  '--yes',
])

if (generateResult.error) {
  cleanupTempOutDir()
  console.error(generateResult.error.message)
  process.exit(1)
}

if (generateResult.status !== 0) {
  if (generateResult.stdout) {
    process.stdout.write(generateResult.stdout)
  }
  if (generateResult.stderr) {
    process.stderr.write(generateResult.stderr)
  }
  cleanupTempOutDir()
  process.exit(generateResult.status ?? 1)
}

const versionResult = runSpacetime(['--version'])
const cliVersion = versionResult.status === 0
  ? versionResult.stdout.trim()
  : undefined

try {
  writeFileSync(
    join(tempOutDir, markerFileName),
    `${JSON.stringify(
      {
        database,
        modulePath: toRepoRelative(modulePath),
        moduleFingerprint,
        generatedAt: new Date().toISOString(),
        ...(cliVersion ? { cliVersion } : {}),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  if (generateResult.stdout) {
    process.stdout.write(generateResult.stdout)
  }

  rmSync(outDir, { recursive: true, force: true })
  renameSync(tempOutDir, outDir)
} finally {
  if (existsSync(tempOutDir)) {
    cleanupTempOutDir()
  }
}

console.log(`Generated SpacetimeDB bindings in ${toRepoRelative(outDir)}.`)
