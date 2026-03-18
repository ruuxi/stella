import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { getElectronApi } from '@/platform/electron/electron'
import type { LocalDevProjectRecord } from '@/shared/types/electron'
import { DISCOVERY_CATEGORIES_CHANGED_EVENT } from '@/shared/contracts/discovery'

type DevProjectsContextValue = {
  projects: LocalDevProjectRecord[]
  isLoading: boolean
  refreshProjects: () => Promise<LocalDevProjectRecord[]>
  pickProjectDirectory: () => Promise<LocalDevProjectRecord | null>
  startProject: (projectId: string) => Promise<void>
  stopProject: (projectId: string) => Promise<void>
}

const DevProjectsContext = createContext<DevProjectsContextValue | null>(null)

const normalizeProjectRuntime = (value: unknown) => {
  if (!value || typeof value !== 'object') {
    return { status: 'stopped' as const }
  }

  const runtime = value as Record<string, unknown>
  const status: LocalDevProjectRecord['runtime']['status'] =
    runtime.status === 'starting'
    || runtime.status === 'running'
    || runtime.status === 'error'
      ? runtime.status
      : 'stopped'

  return {
    status,
    port: typeof runtime.port === 'number' ? runtime.port : undefined,
    url: typeof runtime.url === 'string' ? runtime.url : undefined,
    error: typeof runtime.error === 'string' ? runtime.error : undefined,
  }
}

const normalizeProjects = (value: unknown): LocalDevProjectRecord[] =>
  (Array.isArray(value) ? value : []).reduce<LocalDevProjectRecord[]>((accumulator, project) => {
    if (!project || typeof project !== 'object') {
      return accumulator
    }

    const candidate = project as Record<string, unknown>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
    const projectPath = typeof candidate.path === 'string' ? candidate.path.trim() : ''
    if (!id || !name || !projectPath) {
      return accumulator
    }

    accumulator.push({
      id,
      name,
      path: projectPath,
      source: candidate.source === 'manual' ? 'manual' : 'discovered',
      framework:
        candidate.framework === 'next'
        || candidate.framework === 'vite'
        || candidate.framework === 'create-react-app'
        || candidate.framework === 'angular'
          ? candidate.framework
          : 'unknown',
      packageManager:
        candidate.packageManager === 'pnpm'
        || candidate.packageManager === 'yarn'
        || candidate.packageManager === 'bun'
          ? candidate.packageManager
          : 'npm',
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
      updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
      lastDetectedAt:
        typeof candidate.lastDetectedAt === 'number' ? candidate.lastDetectedAt : undefined,
      runtime: normalizeProjectRuntime(candidate.runtime),
    })

    return accumulator
  }, [])

export function DevProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<LocalDevProjectRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const applyProjects = useCallback((nextProjects: unknown) => {
    const normalized = normalizeProjects(nextProjects)
    startTransition(() => {
      setProjects(normalized)
    })
    return normalized
  }, [])

  const refreshProjects = useCallback(async () => {
    const electronApi = getElectronApi()
    if (!electronApi?.projects?.list) {
      setIsLoading(false)
      return []
    }

    try {
      const nextProjects = await electronApi.projects.list()
      return applyProjects(nextProjects)
    } finally {
      setIsLoading(false)
    }
  }, [applyProjects])

  const pickProjectDirectory = useCallback(async () => {
    const electronApi = getElectronApi()
    if (!electronApi?.projects?.pickDirectory) {
      return null
    }

    const result = await electronApi.projects.pickDirectory()
    const normalizedProjects = applyProjects(result.projects)
    if (result.canceled || !result.selectedProjectId) {
      return null
    }

    return normalizedProjects.find((project) => project.id === result.selectedProjectId) ?? null
  }, [applyProjects])

  const startProject = useCallback(
    async (projectId: string) => {
      const electronApi = getElectronApi()
      if (!electronApi?.projects?.start) {
        return
      }
      const nextProjects = await electronApi.projects.start(projectId)
      applyProjects(nextProjects)
    },
    [applyProjects],
  )

  const stopProject = useCallback(
    async (projectId: string) => {
      const electronApi = getElectronApi()
      if (!electronApi?.projects?.stop) {
        return
      }
      const nextProjects = await electronApi.projects.stop(projectId)
      applyProjects(nextProjects)
    },
    [applyProjects],
  )

  useEffect(() => {
    void refreshProjects()

    const electronApi = getElectronApi()
    const unsubscribe = electronApi?.projects?.onChanged?.((nextProjects) => {
      applyProjects(nextProjects)
      setIsLoading(false)
    })

    const handleDiscoveryCategoriesChanged = () => {
      void refreshProjects()
    }

    window.addEventListener(DISCOVERY_CATEGORIES_CHANGED_EVENT, handleDiscoveryCategoriesChanged)

    return () => {
      unsubscribe?.()
      window.removeEventListener(
        DISCOVERY_CATEGORIES_CHANGED_EVENT,
        handleDiscoveryCategoriesChanged,
      )
    }
  }, [applyProjects, refreshProjects])

  const value = useMemo<DevProjectsContextValue>(
    () => ({
      projects,
      isLoading,
      refreshProjects,
      pickProjectDirectory,
      startProject,
      stopProject,
    }),
    [projects, isLoading, refreshProjects, pickProjectDirectory, startProject, stopProject],
  )

  return <DevProjectsContext.Provider value={value}>{children}</DevProjectsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useDevProjects = () => {
  const context = useContext(DevProjectsContext)
  if (!context) {
    throw new Error('useDevProjects must be used within DevProjectsProvider')
  }
  return context
}
