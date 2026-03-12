import type { AgentHealth } from '@/types/electron'

const isTokenReadinessIssue = (reason: string | null): boolean => {
  if (!reason) return false

  const normalized = reason.toLowerCase()
  return normalized.includes('token') || normalized.includes('auth')
}

const toErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error

  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }

  return ''
}

export const isOrchestratorBusyError = (error: unknown): boolean =>
  toErrorMessage(error).toLowerCase().includes('orchestrator is already running')

export const getAgentHealthReason = (
  health: AgentHealth | null | undefined,
): string | null => {
  if (!health || health.ready) return null
  if (typeof health.reason === 'string' && health.reason.trim()) {
    return health.reason.trim()
  }
  return null
}

export const resolveAgentNotReadyToast = (
  reason: string | null,
): { title: string; description?: string } => {
  if (!reason) {
    return {
      title: 'Stella is still starting up',
      description: 'Please try again in a moment.',
    }
  }

  if (isTokenReadinessIssue(reason)) {
    return {
      title: 'Sign-in is still syncing',
      description: 'Please wait a few seconds and try again.',
    }
  }

  if (reason.toLowerCase().includes('proxy url')) {
    return {
      title: 'Stella setup is incomplete',
      description: 'Please restart Stella and try again.',
    }
  }

  return {
    title: 'Stella is still starting up',
    description: 'Please try again in a moment.',
  }
}

export const trySyncHostToken = async (): Promise<boolean> => {
  if (!window.electronAPI?.system.setAuthState) return false

  try {
    const { getConvexToken } = await import('@/global/auth/services/auth-token')
    const token = await getConvexToken()
    if (!token) return false

    await window.electronAPI.system.setAuthState({
      authenticated: true,
      token,
    })
    return true
  } catch {
    return false
  }
}

