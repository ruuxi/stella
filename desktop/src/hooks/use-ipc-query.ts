import { useCallback, useEffect, useRef, useState } from "react";
import type { MiniBridgeRequest, MiniBridgeResponse } from "../types/electron";

type UseIpcQueryOptions<TData> = {
  enabled?: boolean;
  request: MiniBridgeRequest | null;
  select: (response: MiniBridgeResponse) => TData | null;
};

type UseIpcQueryResult<TData> = {
  data: TData | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
};

export function useIpcQuery<TData>({
  enabled = true,
  request,
  select,
}: UseIpcQueryOptions<TData>): UseIpcQueryResult<TData> {
  const [data, setData] = useState<TData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);

  const runQuery = useCallback(async () => {
    if (!enabled || !request || !window.electronAPI?.mini.request) {
      return;
    }

    const seq = sequenceRef.current + 1;
    sequenceRef.current = seq;
    setLoading(true);
    setError(null);

    try {
      const response = await window.electronAPI.mini.request(request);
      if (sequenceRef.current !== seq) {
        return;
      }

      if (response.type === "error") {
        setError(response.message || "IPC query failed");
        return;
      }

      const nextData = select(response);
      if (nextData === null) {
        setError("Unexpected IPC response");
        return;
      }

      setData(nextData);
    } catch (queryError) {
      if (sequenceRef.current !== seq) {
        return;
      }
      const message =
        queryError instanceof Error ? queryError.message : "IPC query failed";
      setError(message);
    } finally {
      if (sequenceRef.current === seq) {
        setLoading(false);
      }
    }
  }, [enabled, request, select]);

  useEffect(() => {
    void runQuery();
  }, [runQuery]);

  return {
    data,
    loading,
    error,
    refetch: runQuery,
  };
}
