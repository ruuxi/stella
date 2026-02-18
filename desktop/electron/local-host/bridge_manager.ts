import { spawn, type ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const BRIDGES_DIR = path.join(os.homedir(), '.stella', 'bridges')
const SIGKILL_TIMEOUT_MS = 5000
const BRIDGE_STARTUP_GRACE_MS = 1200
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i
const NPM_PACKAGE_VERSION_PATTERN = /^[a-z0-9*^~<>=|.+-]+$/i

type BridgeBundle = {
  provider: string
  code: string
  env: Record<string, string>
  dependencies: string
}

const processes = new Map<string, ChildProcess>()
const bridgeEnv = new Map<string, Record<string, string>>()

const normalizeProviderId = (provider: string): string => {
  const trimmed = provider.trim()
  if (!PROVIDER_ID_PATTERN.test(trimmed)) {
    throw new Error(
      'Bridge provider must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/ for safety.',
    )
  }
  return trimmed
}

const resolveProviderDir = (provider: string) => {
  const providerId = normalizeProviderId(provider)
  const dir = path.resolve(BRIDGES_DIR, providerId)
  const relative = path.relative(BRIDGES_DIR, dir)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid bridge provider path.')
  }
  return { providerId, dir }
}

const parseDependencySpec = (spec: string): { name: string; version: string } => {
  const trimmed = spec.trim()
  const atIndex = trimmed.startsWith('@')
    ? trimmed.indexOf('@', 1)
    : trimmed.lastIndexOf('@')
  const hasVersion = atIndex > 0 && atIndex < trimmed.length - 1
  if (!hasVersion) {
    throw new Error(`Unpinned dependency spec rejected: ${trimmed}`)
  }
  const name = trimmed.slice(0, atIndex)
  const version = trimmed.slice(atIndex + 1)
  if (!NPM_PACKAGE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid package name in dependency spec: ${trimmed}`)
  }
  if (!NPM_PACKAGE_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid package version in dependency spec: ${trimmed}`)
  }
  return { name, version }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timeout)
      const details = err instanceof Error ? err.message : String(err)
      reject(new Error(`${command} ${args.join(' ')} failed to start: ${details}`))
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

export async function deploy(bundle: BridgeBundle): Promise<{ ok: boolean; error?: string }> {
  try {
    const { providerId, dir } = resolveProviderDir(bundle.provider)
    await ensureDir(dir)
    bridgeEnv.set(providerId, bundle.env)

    // Write bridge code
    await fs.writeFile(path.join(dir, 'bridge.js'), bundle.code, 'utf-8')

    // Install npm dependencies if any
    if (bundle.dependencies.trim()) {
      const pkgJson = {
        name: `stella-bridge-${providerId}`,
        version: '1.0.0',
        private: true,
        dependencies: {} as Record<string, string>,
      }
      for (const spec of bundle.dependencies.split(/\s+/).filter(Boolean)) {
        const { name, version } = parseDependencySpec(spec)
        pkgJson.dependencies[name] = version
      }
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf-8')

      if (process.platform === 'win32') {
        await runCommand(
          'cmd.exe',
          ['/d', '/s', '/c', 'npm install --production'],
          dir,
          120_000,
        )
      } else {
        await runCommand('npm', ['install', '--production'], dir, 120_000)
      }
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function start(provider: string): Promise<{ ok: boolean; error?: string }> {
  let providerId: string
  let dir: string
  try {
    const resolved = resolveProviderDir(provider)
    providerId = resolved.providerId
    dir = resolved.dir
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }

  if (processes.has(providerId)) {
    const existing = processes.get(providerId)!
    if (!existing.killed && existing.exitCode === null) {
      return { ok: true } // Already running
    }
    processes.delete(providerId)
  }

  const bridgePath = path.join(dir, 'bridge.js')
  const env = bridgeEnv.get(providerId)

  try {
    await fs.access(bridgePath)
    if (!env) {
      return { ok: false, error: `Bridge environment is missing for provider ${providerId}` }
    }

    const child = spawn('node', [bridgePath], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...process.env, ...env },
    })

    child.stdout?.on('data', (data: Buffer) => {
      console.log(`[bridge:${providerId}]`, data.toString().trimEnd())
    })

    child.stderr?.on('data', (data: Buffer) => {
      console.error(`[bridge:${providerId}]`, data.toString().trimEnd())
    })

    child.on('exit', (code) => {
      console.log(`[bridge:${providerId}] Process exited with code ${code}`)
      processes.delete(providerId)
    })

    child.on('error', (err) => {
      console.error(`[bridge:${providerId}] Process error:`, err.message)
      processes.delete(providerId)
    })

    processes.set(providerId, child)

    const startupResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve({ ok: true })
      }, BRIDGE_STARTUP_GRACE_MS)

      const onError = (err: Error) => {
        cleanup()
        resolve({ ok: false, error: err.message })
      }

      const onExit = (code: number | null) => {
        cleanup()
        const codeLabel = typeof code === 'number' ? String(code) : 'unknown'
        resolve({ ok: false, error: `Bridge process exited during startup (code ${codeLabel})` })
      }

      const cleanup = () => {
        clearTimeout(timer)
        child.off('error', onError)
        child.off('exit', onExit)
      }

      child.once('error', onError)
      child.once('exit', onExit)
    })

    if (!startupResult.ok) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already dead
      }
      processes.delete(providerId)
      return startupResult
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function stop(provider: string): { ok: boolean } {
  let providerId: string
  try {
    providerId = normalizeProviderId(provider)
  } catch {
    return { ok: true }
  }
  const child = processes.get(providerId)
  if (!child) return { ok: true }

  try {
    child.kill('SIGTERM')

    // Fallback: force kill after timeout
    const killTimer = setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL')
      } catch {
        // Already dead
      }
    }, SIGKILL_TIMEOUT_MS)

    child.on('exit', () => clearTimeout(killTimer))
  } catch {
    // Already dead
  }

  processes.delete(providerId)
  return { ok: true }
}

export function stopAll(): void {
  for (const [provider] of processes) {
    stop(provider)
  }
}

export function isRunning(provider: string): boolean {
  let providerId: string
  try {
    providerId = normalizeProviderId(provider)
  } catch {
    return false
  }
  const child = processes.get(providerId)
  if (!child) return false
  return !child.killed && child.exitCode === null
}
