/**
 * useLocalMutation — React hook that replaces Convex's useMutation for local mode.
 * Sends HTTP requests to the local server.
 */

import { useState, useCallback } from "react";
import { localPost, localPut, localPatch, localDelete } from "@/services/local-client";

type HttpMethod = "POST" | "PUT" | "PATCH" | "DELETE";

type UseLocalMutationOptions = {
  method?: HttpMethod;
  onSuccess?: (data: unknown) => void;
  onError?: (error: Error) => void;
};

type UseLocalMutationResult<TArgs = unknown> = {
  mutate: (args?: TArgs) => Promise<unknown>;
  isLoading: boolean;
  error: Error | null;
};

export function useLocalMutation<TArgs = unknown>(
  path: string,
  options: UseLocalMutationOptions = {},
): UseLocalMutationResult<TArgs> {
  const { method = "POST", onSuccess, onError } = options;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutate = useCallback(
    async (args?: TArgs): Promise<unknown> => {
      setIsLoading(true);
      setError(null);

      try {
        let result: unknown;
        switch (method) {
          case "PUT":
            result = await localPut(path, args);
            break;
          case "PATCH":
            result = await localPatch(path, args);
            break;
          case "DELETE":
            result = await localDelete(path);
            break;
          default:
            result = await localPost(path, args);
        }

        onSuccess?.(result);
        return result;
      } catch (err) {
        const error = err as Error;
        setError(error);
        onError?.(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [path, method, onSuccess, onError],
  );

  return { mutate, isLoading, error };
}
