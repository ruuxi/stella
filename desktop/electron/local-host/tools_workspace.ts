/**
 * Workspace CRUD and dev server process management.
 *
 * Workspaces live at $STELLA_WORKSPACES_ROOT/{name}/ (default: ~/workspaces,
 * with legacy ~/.stella fallback) and are scaffolded as Vite+React projects.
 * The dev server is spawned via `bunx vite`.
 */

import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { spawn, type ChildProcess } from 'child_process'
import type { ToolResult } from './tools-types.js'
import {
  packageJsonTemplate,
  viteConfigTemplate,
  indexHtmlTemplate,
  mainTsxTemplate,
  appTsxTemplate,
  tsconfigTemplate,
} from './workspace_templates.js'

type WorkspaceRecord = {
  id: string
  name: string
  path: string
  port: number | null
  url: string | null
  running: boolean
}

const workspaces = new Map<string, WorkspaceRecord>()
const processes = new Map<string, ChildProcess>()

const getPrimaryWorkspacesRoot = () =>
  process.env.STELLA_WORKSPACES_ROOT?.trim() || path.join(os.homedir(), 'workspaces')
const getLegacyWorkspacesRoot = () => path.join(os.homedir(), '.stella', 'workspaces')

export const getWorkspaceRoots = () => [
  getPrimaryWorkspacesRoot(),
  getLegacyWorkspacesRoot(),
]

const findExistingWorkspacePath = async (workspaceId: string): Promise<string | null> => {
  for (const root of getWorkspaceRoots()) {
    const candidate = path.join(root, workspaceId)
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Continue checking fallback roots.
    }
  }
  return null
}

const toId = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')

/**
 * Find an available port by trying to listen briefly.
 */
const findPort = async (startPort: number): Promise<number> => {
  const net = await import('net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(startPort, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : startPort
      server.close(() => resolve(port))
    })
    server.on('error', () => {
      if (startPort > 65530) {
        reject(new Error('No available ports found'))
        return
      }
      resolve(findPort(startPort + 1))
    })
  })
}

export const handleCreateWorkspace = async (
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const name = String(args.name ?? '').trim()
  if (!name) return { error: 'Workspace name is required.' }

  const id = toId(name)
  const root = getPrimaryWorkspacesRoot()
  const wsPath = path.join(root, id)

  try {
    await fs.mkdir(wsPath, { recursive: true })
    await fs.mkdir(path.join(wsPath, 'src'), { recursive: true })

    const deps = args.dependencies as Record<string, string> | undefined

    // Write scaffold files
    await Promise.all([
      fs.writeFile(path.join(wsPath, 'package.json'), packageJsonTemplate(name, deps)),
      fs.writeFile(path.join(wsPath, 'vite.config.ts'), viteConfigTemplate()),
      fs.writeFile(path.join(wsPath, 'index.html'), indexHtmlTemplate(name)),
      fs.writeFile(path.join(wsPath, 'tsconfig.json'), tsconfigTemplate()),
      fs.writeFile(path.join(wsPath, 'src', 'main.tsx'), mainTsxTemplate()),
      fs.writeFile(
        path.join(wsPath, 'src', 'App.tsx'),
        typeof args.source === 'string' ? args.source : appTsxTemplate(name),
      ),
    ])

    // Install dependencies
    const shell = process.platform === 'win32' ? 'cmd' : 'bash'
    const shellArgs = process.platform === 'win32'
      ? ['/c', 'bun install']
      : ['-c', 'bun install']

    await new Promise<void>((resolve, reject) => {
      const child = spawn(shell, shellArgs, { cwd: wsPath, stdio: 'pipe' })
      let output = ''
      child.stdout?.on('data', (d: Buffer) => { output += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { output += d.toString() })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`bun install failed (exit ${code}):\n${output}`))
      })
      child.on('error', reject)
    })

    const record: WorkspaceRecord = {
      id,
      name,
      path: wsPath,
      port: null,
      url: null,
      running: false,
    }
    workspaces.set(id, record)

    return {
      result: JSON.stringify({
        workspaceId: id,
        path: wsPath,
        status: 'created',
      }),
    }
  } catch (err) {
    return { error: `Failed to create workspace: ${(err as Error).message}` }
  }
}

export const handleStartDevServer = async (
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const id = String(args.workspaceId ?? '').trim()
  if (!id) return { error: 'workspaceId is required.' }

  const record = workspaces.get(id)
  if (!record) {
    const wsPath = await findExistingWorkspacePath(id)
    if (!wsPath) {
      return { error: `Workspace ${id} not found.` }
    }
    workspaces.set(id, {
      id,
      name: id,
      path: wsPath,
      port: null,
      url: null,
      running: false,
    })
  }

  const ws = workspaces.get(id)!

  if (ws.running && ws.port) {
    return { result: JSON.stringify({ url: ws.url, port: ws.port }) }
  }

  try {
    const port = await findPort(5180)
    const shell = process.platform === 'win32' ? 'cmd' : 'bash'
    const shellArgs = process.platform === 'win32'
      ? ['/c', `bunx vite --port ${port}`]
      : ['-c', `bunx vite --port ${port}`]

    const child = spawn(shell, shellArgs, {
      cwd: ws.path,
      stdio: 'pipe',
      env: { ...process.env },
    })

    processes.set(id, child)

    // Wait for server ready
    await new Promise<void>((resolve) => {
      let ready = false
      const timer = setTimeout(() => {
        if (!ready) {
          ready = true
          resolve()
        }
      }, 10_000)

      const check = (data: Buffer) => {
        const text = data.toString()
        if (text.includes('Local:') || text.includes('localhost')) {
          if (!ready) {
            ready = true
            clearTimeout(timer)
            resolve()
          }
        }
      }

      child.stdout?.on('data', check)
      child.stderr?.on('data', check)
    })

    ws.port = port
    ws.url = `http://localhost:${port}`
    ws.running = true

    child.on('close', () => {
      ws.running = false
      ws.port = null
      ws.url = null
      processes.delete(id)
    })

    return {
      result: JSON.stringify({ url: ws.url, port }),
    }
  } catch (err) {
    return { error: `Failed to start dev server: ${(err as Error).message}` }
  }
}

export const handleStopDevServer = async (
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const id = String(args.workspaceId ?? '').trim()
  if (!id) return { error: 'workspaceId is required.' }

  const child = processes.get(id)
  if (!child) {
    return { result: JSON.stringify({ stopped: true, note: 'No running server.' }) }
  }

  child.kill()
  processes.delete(id)

  const ws = workspaces.get(id)
  if (ws) {
    ws.running = false
    ws.port = null
    ws.url = null
  }

  return { result: JSON.stringify({ stopped: true }) }
}

export const handleListWorkspaces = async (): Promise<ToolResult> => {
  try {
    const seen = new Set<string>()
    const list: WorkspaceRecord[] = []

    for (const root of getWorkspaceRoots()) {
      await fs.mkdir(root, { recursive: true })
      const entries = await fs.readdir(root, { withFileTypes: true })
      const dirs = entries.filter(e => e.isDirectory())

      for (const dir of dirs) {
        if (seen.has(dir.name)) continue
        seen.add(dir.name)

        const existing = workspaces.get(dir.name)
        if (existing) {
          list.push(existing)
          continue
        }

        list.push({
          id: dir.name,
          name: dir.name,
          path: path.join(root, dir.name),
          port: null,
          url: null,
          running: false,
        })
      }
    }

    return { result: JSON.stringify(list) }
  } catch (err) {
    return { error: `Failed to list workspaces: ${(err as Error).message}` }
  }
}
