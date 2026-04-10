#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Parse arguments: <app-name> [--template <template-name>]
const args = process.argv.slice(2)
let rawName = ''
let templateName = 'workspace-app'

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--template' && args[i + 1]) {
    templateName = args[++i]
  } else if (!arg.startsWith('--') && !rawName) {
    rawName = arg.trim()
  }
}

if (!rawName) {
  console.error(
    'Usage: node scripts/create-workspace-app.mjs <app-name> [--template workspace-app]',
  )
  process.exit(1)
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(rawName)) {
  console.error('Invalid app name. Use only letters, numbers, "-" and "_".')
  process.exit(1)
}

const src = join(__dirname, '..', 'templates', templateName)
const appsDir = join(__dirname, '..', 'workspace', 'apps')
mkdirSync(appsDir, { recursive: true })
const dest = join(appsDir, rawName)

const resolvedAppsDir = resolve(appsDir)
const resolvedDest = resolve(dest)
if (!resolvedDest.startsWith(`${resolvedAppsDir}${sep}`)) {
  console.error('Invalid app name.')
  process.exit(1)
}

if (!existsSync(src)) {
  console.error(`Template not found: ${templateName}`)
  process.exit(1)
}

if (existsSync(dest)) {
  console.error(`Destination already exists: ${dest}`)
  process.exit(1)
}

cpSync(src, dest, { recursive: true })

// Files that may contain placeholders
const placeholderFiles = ['package.json', 'index.html', 'src/App.tsx']

for (const file of placeholderFiles) {
  const filePath = join(dest, file)
  try {
    const content = readFileSync(filePath, 'utf-8')
    const updated = content.replaceAll('{{name}}', rawName)
    writeFileSync(filePath, updated, 'utf-8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      continue
    }

    console.error(`Failed to rewrite placeholders in ${filePath}: ${error?.message ?? error}`)
    process.exit(1)
  }
}

console.log(`Created app: ${dest} (template: ${templateName})`)
