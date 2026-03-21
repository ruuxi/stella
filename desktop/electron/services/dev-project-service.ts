import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { promises as fs } from 'fs'
import crypto from 'crypto'
import net from 'net'
import path from 'path'
import { collectDevProjects } from '../system/dev-projects.js'
import { writePrivateFile } from '../system/private-fs.js'
import type { StellaHomePathTarget } from './lifecycle-targets.js'
import type {
  DiscoveryCategory,
} from '../../src/shared/contracts/discovery.js'
import type {
  DevProject,
  LocalDevProjectFramework,
  LocalDevProjectPackageManager,
  LocalDevProjectRecord,
  LocalDevProjectRuntime,
  LocalDevProjectSource,
} from '../../packages/stella-boundary-contracts/src/index.js'

const REGISTRY_FILENAME = 'dev-projects.json'
const DISCOVERY_CATEGORIES_FILENAME = 'discovery_categories.json'
const DISCOVERY_CATEGORY_DEV_ENVIRONMENT: DiscoveryCategory = 'dev_environment'
const DEFAULT_START_PORT = 4100
const MAX_PORT_ATTEMPTS = 200
const STARTUP_TIMEOUT_MS = 90_000
const HTTP_POLL_INTERVAL_MS = 700
const PROJECT_LOG_LINE_LIMIT = 80

type PackageJsonShape = {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

type StoredLocalDevProject = Omit<LocalDevProjectRecord, 'runtime'>

type DevProjectRegistryState = {
  version: 1
  discoverySeeded: boolean
  projects: StoredLocalDevProject[]
}

type RuntimeSession = {
  status: LocalDevProjectRuntime['status']
  child: ChildProcessWithoutNullStreams
  port: number
  url: string
  abortController: AbortController
  logs: string[]
  stopping: boolean
  error?: string
}

type ProjectMetadata = {
  name: string
  framework: LocalDevProjectFramework
  packageManager: LocalDevProjectPackageManager
  scriptName: string
}

type StartCommand = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  shell?: boolean
}

const createDefaultRegistryState = (): DevProjectRegistryState => ({
  version: 1,
  discoverySeeded: false,
  projects: [],
})

const normalizeProjectPath = (value: string) =>
  path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const toTrimmedString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const coerceFramework = (value: unknown): LocalDevProjectFramework => {
  switch (value) {
    case 'next':
    case 'vite':
    case 'create-react-app':
    case 'angular':
      return value
    default:
      return 'unknown'
  }
}

const coercePackageManager = (value: unknown): LocalDevProjectPackageManager => {
  switch (value) {
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return value
    default:
      return 'npm'
  }
}

const coerceSource = (value: unknown): LocalDevProjectSource =>
  value === 'manual' ? 'manual' : 'discovered'

const coerceTimestamp = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const sanitizeRegistryState = (value: unknown): DevProjectRegistryState => {
  if (!value || typeof value !== 'object') {
    return createDefaultRegistryState()
  }

  const input = value as Partial<DevProjectRegistryState>
  const now = Date.now()
  const projects = Array.isArray(input.projects) ? input.projects : []
  const sanitizedProjects: StoredLocalDevProject[] = []
  for (const project of projects) {
    if (!project || typeof project !== 'object') {
      continue
    }

    const candidate = project as Partial<StoredLocalDevProject>
    const id = toTrimmedString(candidate.id)
    const name = toTrimmedString(candidate.name)
    const projectPath = toTrimmedString(candidate.path)
    if (!id || !name || !projectPath) {
      continue
    }

    const createdAt = coerceTimestamp(candidate.createdAt, now)
    const updatedAt = coerceTimestamp(candidate.updatedAt, createdAt)
    const lastDetectedAt =
      typeof candidate.lastDetectedAt === 'number' && Number.isFinite(candidate.lastDetectedAt)
        ? candidate.lastDetectedAt
        : undefined

    sanitizedProjects.push({
      id,
      name,
      path: path.resolve(projectPath),
      source: coerceSource(candidate.source),
      framework: coerceFramework(candidate.framework),
      packageManager: coercePackageManager(candidate.packageManager),
      createdAt,
      updatedAt,
      lastDetectedAt,
    })
  }

  sanitizedProjects.sort((left, right) => left.name.localeCompare(right.name))

  return {
    version: 1,
    discoverySeeded: Boolean(input.discoverySeeded),
    projects: sanitizedProjects,
  }
}

const appendLogLine = (logs: string[], chunk: string) => {
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return
  }

  logs.push(...lines)
  if (logs.length > PROJECT_LOG_LINE_LIMIT) {
    logs.splice(0, logs.length - PROJECT_LOG_LINE_LIMIT)
  }
}

const isPortAvailable = async (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer()

    server.once('error', () => {
      resolve(false)
    })

    server.once('listening', () => {
      server.close(() => resolve(true))
    })

    server.listen(port, '127.0.0.1')
  })

const delay = async (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', handleAbort)
    }

    const handleAbort = () => {
      cleanup()
      reject(new Error('Aborted'))
    }

    if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true })
    }
  })

const buildStartupError = (message: string, logs: string[]) => {
  if (logs.length === 0) {
    return message
  }
  return `${message}\n\n${logs.slice(-6).join('\n')}`
}

const chooseScriptName = (
  scripts: Record<string, string>,
  framework: LocalDevProjectFramework,
): string | null => {
  const hasScript = (name: string) => typeof scripts[name] === 'string' && scripts[name].trim().length > 0

  if (framework === 'create-react-app') {
    if (hasScript('start')) return 'start'
    if (hasScript('dev')) return 'dev'
  }

  if (framework === 'angular') {
    if (hasScript('start')) return 'start'
    if (hasScript('dev')) return 'dev'
  }

  if (hasScript('dev')) return 'dev'
  if (hasScript('start')) return 'start'
  return null
}

const detectFramework = (pkg: PackageJsonShape): LocalDevProjectFramework => {
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  }
  const scripts = pkg.scripts ?? {}
  const scriptValues = Object.values(scripts).join(' ').toLowerCase()

  if ('next' in deps || scriptValues.includes('next dev')) {
    return 'next'
  }
  if ('vite' in deps || scriptValues.includes('vite')) {
    return 'vite'
  }
  if ('react-scripts' in deps || scriptValues.includes('react-scripts start')) {
    return 'create-react-app'
  }
  if (
    '@angular/core' in deps
    || '@angular/cli' in deps
    || scriptValues.includes('ng serve')
  ) {
    return 'angular'
  }
  return 'unknown'
}

const detectPackageManager = async (
  projectPath: string,
): Promise<LocalDevProjectPackageManager> => {
  const candidates: Array<{ file: string; manager: LocalDevProjectPackageManager }> = [
    { file: 'bun.lock', manager: 'bun' },
    { file: 'bun.lockb', manager: 'bun' },
    { file: 'pnpm-lock.yaml', manager: 'pnpm' },
    { file: 'yarn.lock', manager: 'yarn' },
    { file: 'package-lock.json', manager: 'npm' },
  ]

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.join(projectPath, candidate.file))
      if (stat.isFile()) {
        return candidate.manager
      }
    } catch {
      // Ignore missing lockfiles.
    }
  }

  return 'npm'
}

const resolveCommandBinary = (manager: LocalDevProjectPackageManager) => {
  if (process.platform !== 'win32') {
    return manager === 'yarn' ? 'yarn' : manager
  }

  switch (manager) {
    case 'npm':
      return 'npm.cmd'
    case 'pnpm':
      return 'pnpm.cmd'
    case 'yarn':
      return 'yarn.cmd'
    case 'bun':
      return 'bun.exe'
    default:
      return 'npm.cmd'
  }
}

const shouldLaunchInShell = (command: string) =>
  process.platform === 'win32' && /\.cmd$/i.test(command)

const buildStartCommand = (
  projectPath: string,
  metadata: ProjectMetadata,
  port: number,
): StartCommand => {
  const host = '127.0.0.1'
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOST: host,
    BROWSER: 'none',
  }

  const command = resolveCommandBinary(metadata.packageManager)
  const args =
    metadata.packageManager === 'yarn'
      ? [metadata.scriptName]
      : ['run', metadata.scriptName]

  const extraArgs: string[] = []
  switch (metadata.framework) {
    case 'next':
      extraArgs.push('--hostname', host, '--port', String(port))
      break
    case 'vite':
      extraArgs.push('--host', host, '--port', String(port))
      break
    case 'angular':
      extraArgs.push('--host', host, '--port', String(port))
      break
    case 'create-react-app':
      break
    case 'unknown':
      break
  }

  if (extraArgs.length > 0) {
    args.push('--', ...extraArgs)
  }

  return {
    command,
    args,
    env: baseEnv,
    shell: shouldLaunchInShell(command),
  }
}

const killChildTree = async (child: ChildProcessWithoutNullStreams) => {
  const pid = child.pid
  if (!pid || child.killed) {
    return
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('exit', () => resolve())
      killer.once('error', () => resolve())
    })
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }

  await delay(750).catch(() => undefined)

  if (child.exitCode === null) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Process already exited.
    }
  }
}

const waitForHttpServer = async (url: string, signal: AbortSignal): Promise<void> => {
  const startedAt = Date.now()

  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (signal.aborted) {
      throw new Error('Aborted')
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal,
      })
      if (response.ok || response.status < 500) {
        return
      }
    } catch {
      // Retry until timeout.
    }

    await delay(HTTP_POLL_INTERVAL_MS, signal)
  }

  throw new Error(`Timed out waiting for the dev server on ${url}.`)
}

const readPackageJson = async (projectPath: string): Promise<PackageJsonShape> => {
  const packageJsonPath = path.join(projectPath, 'package.json')
  let stat
  try {
    stat = await fs.stat(packageJsonPath)
  } catch {
    throw new Error('This folder does not contain a package.json file.')
  }

  if (!stat.isFile()) {
    throw new Error('This folder does not contain a package.json file.')
  }

  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8')
    return JSON.parse(raw) as PackageJsonShape
  } catch {
    throw new Error('The package.json file could not be read.')
  }
}

const inspectProject = async (projectPath: string): Promise<ProjectMetadata> => {
  const pkg = await readPackageJson(projectPath)
  const framework = detectFramework(pkg)
  const scripts = pkg.scripts ?? {}
  const scriptName = chooseScriptName(scripts, framework)
  if (!scriptName) {
    throw new Error('This project does not define a startable dev script.')
  }

  return {
    name: toTrimmedString(pkg.name) ?? path.basename(projectPath),
    framework,
    packageManager: await detectPackageManager(projectPath),
    scriptName,
  }
}

export class DevProjectService {
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly runtimeErrors = new Map<string, string>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly stellaHomePathTarget: StellaHomePathTarget) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async listProjects(): Promise<LocalDevProjectRecord[]> {
    const registry = await this.ensureDiscoverySeeded(await this.readRegistry())
    return this.composeProjectRecords(registry.projects)
  }

  async pickProjectDirectory(projectPath: string): Promise<{ projects: LocalDevProjectRecord[]; selectedProjectId: string }> {
    const metadata = await inspectProject(projectPath)
    const registry = await this.ensureDiscoverySeeded(await this.readRegistry())
    const now = Date.now()
    const normalizedPath = normalizeProjectPath(projectPath)
    const existingProject = registry.projects.find(
      (project) => normalizeProjectPath(project.path) === normalizedPath,
    )

    if (existingProject) {
      existingProject.name = metadata.name
      existingProject.path = path.resolve(projectPath)
      existingProject.framework = metadata.framework
      existingProject.packageManager = metadata.packageManager
      existingProject.source = 'manual'
      existingProject.updatedAt = now
      await this.writeRegistry(registry)
      this.emitChanged()
      return {
        projects: this.composeProjectRecords(registry.projects),
        selectedProjectId: existingProject.id,
      }
    }

    const nextProject: StoredLocalDevProject = {
      id: crypto.randomUUID(),
      name: metadata.name,
      path: path.resolve(projectPath),
      source: 'manual',
      framework: metadata.framework,
      packageManager: metadata.packageManager,
      createdAt: now,
      updatedAt: now,
    }

    registry.projects.push(nextProject)
    registry.projects.sort((left, right) => left.name.localeCompare(right.name))
    await this.writeRegistry(registry)
    this.emitChanged()

    return {
      projects: this.composeProjectRecords(registry.projects),
      selectedProjectId: nextProject.id,
    }
  }

  async startProject(projectId: string): Promise<LocalDevProjectRecord[]> {
    const registry = await this.ensureDiscoverySeeded(await this.readRegistry())
    const storedProject = registry.projects.find((project) => project.id === projectId)
    if (!storedProject) {
      throw new Error('Project not found.')
    }

    const existingSession = this.sessions.get(projectId)
    if (existingSession && (existingSession.status === 'starting' || existingSession.status === 'running')) {
      return this.composeProjectRecords(registry.projects)
    }

    this.runtimeErrors.delete(projectId)
    const metadata = await inspectProject(storedProject.path)
    storedProject.name = metadata.name
    storedProject.framework = metadata.framework
    storedProject.packageManager = metadata.packageManager
    storedProject.updatedAt = Date.now()
    await this.writeRegistry(registry)

    const port = await this.allocatePort()
    const url = `http://127.0.0.1:${port}`
    const command = buildStartCommand(storedProject.path, metadata, port)
    const child = spawn(command.command, command.args, {
      cwd: storedProject.path,
      env: command.env,
      shell: command.shell,
      stdio: 'pipe',
      windowsHide: true,
    })

    const session: RuntimeSession = {
      status: 'starting',
      child,
      port,
      url,
      abortController: new AbortController(),
      logs: [],
      stopping: false,
    }
    this.sessions.set(projectId, session)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => appendLogLine(session.logs, chunk))
    child.stderr.on('data', (chunk: string) => appendLogLine(session.logs, chunk))
    child.once('error', (error) => {
      this.handleRuntimeFailure(projectId, buildStartupError(error.message, session.logs))
    })
    child.once('exit', (code, signal) => {
      if (session.stopping) {
        return
      }

      const reason = code !== null ? `Process exited with code ${code}.` : `Process exited (${signal ?? 'unknown'}).`
      this.handleRuntimeFailure(projectId, buildStartupError(reason, session.logs))
    })

    this.emitChanged()

    void (async () => {
      try {
        await waitForHttpServer(url, session.abortController.signal)
        const currentSession = this.sessions.get(projectId)
        if (!currentSession || currentSession !== session || currentSession.stopping) {
          return
        }

        currentSession.status = 'running'
        currentSession.error = undefined
        this.emitChanged()
      } catch (error) {
        if (session.abortController.signal.aborted) {
          return
        }

        this.handleRuntimeFailure(
          projectId,
          buildStartupError((error as Error).message, session.logs),
        )
        await killChildTree(child)
      }
    })()

    return this.composeProjectRecords(registry.projects)
  }

  async stopProject(projectId: string): Promise<LocalDevProjectRecord[]> {
    const registry = await this.ensureDiscoverySeeded(await this.readRegistry())
    const session = this.sessions.get(projectId)
    if (!session) {
      this.runtimeErrors.delete(projectId)
      return this.composeProjectRecords(registry.projects)
    }

    session.stopping = true
    session.abortController.abort()
    this.sessions.delete(projectId)
    this.runtimeErrors.delete(projectId)
    this.emitChanged()
    await killChildTree(session.child)
    return this.composeProjectRecords(registry.projects)
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.sessions.keys()).map((projectId) => this.stopProject(projectId))
    await Promise.allSettled(stops)
  }

  private getRegistryPath() {
    const stellaHomePath = this.stellaHomePathTarget.getStellaHomePath()
    if (!stellaHomePath) {
      return null
    }
    return path.join(stellaHomePath, 'state', REGISTRY_FILENAME)
  }

  private getDiscoveryCategoriesPath() {
    const stellaHomePath = this.stellaHomePathTarget.getStellaHomePath()
    if (!stellaHomePath) {
      return null
    }
    return path.join(stellaHomePath, 'state', DISCOVERY_CATEGORIES_FILENAME)
  }

  private async readRegistry(): Promise<DevProjectRegistryState> {
    const registryPath = this.getRegistryPath()
    if (!registryPath) {
      return createDefaultRegistryState()
    }
    return sanitizeRegistryState(await readJsonFile<DevProjectRegistryState>(registryPath))
  }

  private async writeRegistry(state: DevProjectRegistryState) {
    const registryPath = this.getRegistryPath()
    if (!registryPath) {
      return
    }
    await writePrivateFile(registryPath, `${JSON.stringify(state, null, 2)}\n`)
  }

  private composeProjectRecords(projects: StoredLocalDevProject[]): LocalDevProjectRecord[] {
    return projects.map((project) => ({
      ...project,
      runtime: this.composeRuntime(project.id),
    }))
  }

  private composeRuntime(projectId: string): LocalDevProjectRuntime {
    const session = this.sessions.get(projectId)
    if (!session) {
      const error = this.runtimeErrors.get(projectId)
      if (error) {
        return {
          status: 'error',
          error,
        }
      }
      return { status: 'stopped' }
    }

    if (session.status === 'error') {
      return {
        status: 'error',
        error: session.error,
      }
    }

    return {
      status: session.status,
      port: session.port,
      url: session.url,
      error: session.error,
    }
  }

  private emitChanged() {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private async ensureDiscoverySeeded(
    state: DevProjectRegistryState,
  ): Promise<DevProjectRegistryState> {
    if (state.discoverySeeded) {
      return state
    }

    const categoriesPath = this.getDiscoveryCategoriesPath()
    if (!categoriesPath) {
      return state
    }

    const discoveryState = await readJsonFile<{ categories?: DiscoveryCategory[] }>(categoriesPath)
    const categories = Array.isArray(discoveryState?.categories) ? discoveryState.categories : []
    if (!categories.includes(DISCOVERY_CATEGORY_DEV_ENVIRONMENT)) {
      return state
    }

    const discoveredProjects = await collectDevProjects()
    const importedProjects = await this.buildDiscoveredProjects(discoveredProjects)
    if (importedProjects.length > 0) {
      const mergedProjects = [...state.projects]
      for (const importedProject of importedProjects) {
        const existing = mergedProjects.find(
          (project) => normalizeProjectPath(project.path) === normalizeProjectPath(importedProject.path),
        )
        if (existing) {
          existing.name = importedProject.name
          existing.framework = importedProject.framework
          existing.packageManager = importedProject.packageManager
          existing.lastDetectedAt = importedProject.lastDetectedAt
          existing.updatedAt = importedProject.updatedAt
          continue
        }
        mergedProjects.push(importedProject)
      }
      mergedProjects.sort((left, right) => left.name.localeCompare(right.name))
      state.projects = mergedProjects
    }

    state.discoverySeeded = true
    await this.writeRegistry(state)
    this.emitChanged()
    return state
  }

  private async buildDiscoveredProjects(
    discoveredProjects: DevProject[],
  ): Promise<StoredLocalDevProject[]> {
    const importedProjects: StoredLocalDevProject[] = []

    for (const discoveredProject of discoveredProjects) {
      try {
        const metadata = await inspectProject(discoveredProject.path)
        importedProjects.push({
          id: crypto.randomUUID(),
          name: metadata.name,
          path: path.resolve(discoveredProject.path),
          source: 'discovered',
          framework: metadata.framework,
          packageManager: metadata.packageManager,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastDetectedAt: discoveredProject.lastActivity,
        })
      } catch {
        // Skip repos that do not map cleanly to a startable local web app.
      }
    }

    return importedProjects
  }

  private async allocatePort(): Promise<number> {
    const reservedPorts = new Set(Array.from(this.sessions.values()).map((session) => session.port))

    for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
      const port = DEFAULT_START_PORT + offset
      if (reservedPorts.has(port)) {
        continue
      }

      if (await isPortAvailable(port)) {
        return port
      }
    }

    throw new Error('No available dev-server ports were found.')
  }

  private handleRuntimeFailure(projectId: string, error: string) {
    const session = this.sessions.get(projectId)
    if (!session) {
      return
    }

    session.status = 'error'
    session.error = error
    session.stopping = true
    session.abortController.abort()
    this.sessions.delete(projectId)
    this.runtimeErrors.set(projectId, error)
    this.emitChanged()
  }
}
