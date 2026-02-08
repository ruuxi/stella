#!/usr/bin/env node
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const name = process.argv[2]
if (!name) {
  console.error('Usage: node create-app.js <app-name>')
  process.exit(1)
}

const src = join(__dirname, 'apps', '_template')
const appsDir = join(homedir(), '.stella', 'apps')
mkdirSync(appsDir, { recursive: true })
const dest = join(appsDir, name)

cpSync(src, dest, { recursive: true })

// Replace {{name}} placeholder in package.json and index.html
for (const file of ['package.json', 'index.html', 'src/App.tsx']) {
  const filePath = join(dest, file)
  const content = readFileSync(filePath, 'utf-8')
  writeFileSync(filePath, content.replaceAll('{{name}}', name), 'utf-8')
}

console.log(`Created app: ${dest}`)
