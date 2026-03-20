#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { dirname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Parse arguments: <app-name> [--template <template-name>]
const args = process.argv.slice(2)
let rawName = ''
let templateName = 'workspace-app'
let spacetimeDbModule = 'stella-w08uu'

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--template' && args[i + 1]) {
    templateName = args[++i]
  } else if (arg === '--spacetimedb-module' && args[i + 1]) {
    spacetimeDbModule = args[++i]
  } else if (!arg.startsWith('--') && !rawName) {
    rawName = arg.trim()
  }
}

if (!rawName) {
  console.error('Usage: node scripts/create-workspace-app.mjs <app-name> [--template game]')
  process.exit(1)
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(rawName)) {
  console.error('Invalid app name. Use only letters, numbers, "-" and "_".')
  process.exit(1)
}

// Resolve template: "game" is shorthand for "workspace-game-app"
const templateMap = {
  game: 'workspace-game-app',
}
const resolvedTemplate = templateMap[templateName] ?? templateName

const src = join(__dirname, '..', 'templates', resolvedTemplate)
const appsDir = join(__dirname, '..', 'workspace', 'apps')
mkdirSync(appsDir, { recursive: true })
const dest = join(appsDir, rawName)

const resolvedAppsDir = resolve(appsDir)
const resolvedDest = resolve(dest)
if (!resolvedDest.startsWith(`${resolvedAppsDir}${sep}`)) {
  console.error('Invalid app name.')
  process.exit(1)
}

cpSync(src, dest, { recursive: true })

// For the game template, generate a fresh binding set in the new app.
if (resolvedTemplate === 'workspace-game-app') {
  const bindingsDest = join(dest, 'src', 'bindings')
  const generateBindingsScript = join(__dirname, 'generate-game-bindings.mjs')
  rmSync(bindingsDest, { recursive: true, force: true })

  const generateResult = spawnSync(
    process.execPath,
    [
      generateBindingsScript,
      '--database',
      spacetimeDbModule,
      '--out-dir',
      bindingsDest,
      '--force',
    ],
    {
      cwd: join(__dirname, '..'),
      encoding: 'utf-8',
      stdio: 'pipe',
      windowsHide: true,
    },
  )

  if (generateResult.status !== 0) {
    const details = [generateResult.stderr, generateResult.stdout]
      .filter(Boolean)
      .join('\n')
      .trim()
    console.error(details || 'Failed to generate SpacetimeDB bindings.')
    process.exit(generateResult.status ?? 1)
  }
}

// Files that may contain placeholders
const placeholderFiles = [
  'package.json',
  'index.html',
  'src/App.tsx',
  'src/lib/connection.ts',
]

for (const file of placeholderFiles) {
  const filePath = join(dest, file)
  try {
    const content = readFileSync(filePath, 'utf-8')
    const updated = content
      .replaceAll('{{name}}', rawName)
      .replaceAll('{{spacetimedbModule}}', spacetimeDbModule)
    writeFileSync(filePath, updated, 'utf-8')
  } catch {
    // File may not exist in this template — skip
  }
}

console.log(`Created app: ${dest} (template: ${resolvedTemplate})`)
