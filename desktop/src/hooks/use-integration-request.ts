import { useState, useCallback } from 'react'
import { useAction } from 'convex/react'
import { api } from '../convex/api'

type IntegrationRequestArgs = {
  provider: string
  request: {
    url: string
    method?: string
    headers?: Record<string, string>
    query?: Record<string, string | number | boolean>
    body?: unknown
    timeoutMs?: number
  }
  responseType?: 'json' | 'text'
}

type IntegrationResult = {
  data?: unknown
  error?: string
}

/**
 * React hook for generated canvas components to make API calls
 * via the Convex integration proxy.
 */
export const useIntegrationRequest = () => {
  const proxyAction = useAction(api.tools.integration_proxy.execute)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const execute = useCallback(async (args: IntegrationRequestArgs): Promise<IntegrationResult> => {
    setLoading(true)
    setError(null)

    try {
      const result = await proxyAction({
        provider: args.provider,
        request: args.request,
        responseType: args.responseType,
      }) as IntegrationResult

      if (result.error) {
        setError(result.error)
      }

      setLoading(false)
      return result
    } catch (err) {
      const message = (err as Error).message
      setError(message)
      setLoading(false)
      return { error: message }
    }
  }, [proxyAction])

  return { execute, loading, error }
}
