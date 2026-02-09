#!/usr/bin/env node
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rawName = process.argv[2]?.trim()
if (!rawName) {
  console.error('Usage: node create-app.js <app-name>')
  process.exit(1)
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(rawName)) {
  console.error('Invalid app name. Use only letters, numbers, "-" and "_".')
  process.exit(1)
}

const src = join(__dirname, 'apps', '_template')
const appsDir = join(homedir(), '.stella', 'apps')
mkdirSync(appsDir, { recursive: true })
const dest = join(appsDir, rawName)

const resolvedAppsDir = resolve(appsDir)
const resolvedDest = resolve(dest)
if (!resolvedDest.startsWith(`${resolvedAppsDir}${sep}`)) {
  console.error('Invalid app name.')
  process.exit(1)
}

cpSync(src, dest, { recursive: true })

// Replace {{name}} placeholder in package.json and index.html
for (const file of ['package.json', 'index.html', 'src/App.tsx']) {
  const filePath = join(dest, file)
  const content = readFileSync(filePath, 'utf-8')
  writeFileSync(filePath, content.replaceAll('{{name}}', rawName), 'utf-8')
}

console.log(`Created app: ${dest}`)
