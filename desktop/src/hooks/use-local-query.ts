/**
 * useLocalQuery — React hook that replaces Convex's useQuery for local mode.
 * Polls the local HTTP server and optionally subscribes to SSE for real-time updates.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { localGet } from "@/services/local-client";

type UseLocalQueryOptions = {
  /** Disable the query (equivalent to useQuery returning undefined when skip is true) */
  enabled?: boolean;
  /** Refetch interval in ms (0 = no polling, rely on SSE invalidation) */
  pollInterval?: number;
};

type UseLocalQueryResult<T> = {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
};

export function useLocalQuery<T = unknown>(
  path: string | null,
  options: UseLocalQueryOptions = {},
): UseLocalQueryResult<T> {
  const { enabled = true, pollInterval = 0 } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    if (!path || !enabled) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const result = await localGet<T>(path);
      if (mountedRef.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err as Error);
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [path, enabled]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();

    let interval: ReturnType<typeof setInterval> | null = null;
    if (pollInterval > 0 && enabled && path) {
      interval = setInterval(fetchData, pollInterval);
    }

    return () => {
      mountedRef.current = false;
      if (interval) clearInterval(interval);
    };
  }, [fetchData, pollInterval, enabled, path]);

  return { data, isLoading, error, refetch: fetchData };
}
