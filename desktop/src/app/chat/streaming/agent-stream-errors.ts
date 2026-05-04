const isTokenReadinessIssue = (reason: string | null): boolean => {
  if (!reason) return false

  const normalized = reason.toLowerCase()
  return normalized.includes('token') || normalized.includes('auth')
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
