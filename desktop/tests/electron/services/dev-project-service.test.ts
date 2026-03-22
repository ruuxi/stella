import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return {
    ...actual,
    spawn: spawnMock,
  }
})

const { DevProjectService } = await import('../../../packages/runtime-kernel/dev-projects/dev-project-service.js')

const tempDirs: string[] = []
const originalPlatform = process.platform

const createTempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const setPlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, 'platform', {
    value: platform,
  })
}

const createMockStream = () => {
  const stream = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  stream.setEncoding = vi.fn()
  return stream
}

const createMockChild = () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: ReturnType<typeof createMockStream>
    stderr: ReturnType<typeof createMockStream>
    pid: number
    killed: boolean
    exitCode: number | null
  }
  child.stdout = createMockStream()
  child.stderr = createMockStream()
  child.pid = 4321
  child.killed = false
  child.exitCode = null
  return child
}

describe('DevProjectService', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setPlatform(originalPlatform)

    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('spawns Windows npm scripts through a shell', async () => {
    setPlatform('win32')

    const stellaHome = createTempDir('stella-dev-project-home-')
    const projectDir = createTempDir('stella-dev-project-')
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'example-project',
        scripts: {
          dev: 'vite',
        },
      }),
    )
    fs.writeFileSync(path.join(projectDir, 'package-lock.json'), '')

    const registry = {
      version: 1 as const,
      discoverySeeded: true,
      projects: [
        {
          id: 'project-1',
          name: 'example-project',
          path: projectDir,
          source: 'manual' as const,
          framework: 'vite' as const,
          packageManager: 'npm' as const,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }

    spawnMock.mockReturnValue(createMockChild())

    const service = new DevProjectService({
      getStellaHomePath: () => stellaHome,
    })
    vi.spyOn(service as never, 'readRegistry').mockResolvedValue(registry)
    vi.spyOn(service as never, 'ensureDiscoverySeeded').mockImplementation(async (state) => state)
    vi.spyOn(service as never, 'writeRegistry').mockResolvedValue(undefined)
    vi.spyOn(service as never, 'allocatePort').mockResolvedValue(4310)
    vi.spyOn(service as never, 'composeProjectRecords').mockReturnValue([])
    vi.spyOn(service as never, 'emitChanged').mockImplementation(() => {})

    await service.startProject('project-1')
    await Promise.resolve()
    await Promise.resolve()

    expect(spawnMock).toHaveBeenCalledWith(
      'npm.cmd',
      expect.arrayContaining(['run', 'dev']),
      expect.objectContaining({
        cwd: projectDir,
        shell: true,
        windowsHide: true,
      }),
    )
  })
})

