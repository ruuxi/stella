import { useState, useCallback, useRef } from 'react'
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
 * React hook for canvas panel components to make API calls
 * via the Convex integration proxy.
 */
export const useIntegrationRequest = () => {
  const proxyAction = useAction(api.tools.integration_proxy.execute)
  const [inFlightCount, setInFlightCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const latestRequestIdRef = useRef(0)
  const loading = inFlightCount > 0

  const execute = useCallback(async (args: IntegrationRequestArgs): Promise<IntegrationResult> => {
    const requestId = latestRequestIdRef.current + 1
    latestRequestIdRef.current = requestId
    setInFlightCount((prev) => prev + 1)
    setError(null)

    try {
      const result = await proxyAction({
        provider: args.provider,
        request: args.request,
        responseType: args.responseType,
      }) as IntegrationResult

      if (result.error && latestRequestIdRef.current === requestId) {
        setError(result.error)
      }
      return result
    } catch (err) {
      const message = (err as Error).message
      if (latestRequestIdRef.current === requestId) {
        setError(message)
      }
      return { error: message }
    } finally {
      setInFlightCount((prev) => prev - 1)
    }
  }, [proxyAction])

  return { execute, loading, error }
}
