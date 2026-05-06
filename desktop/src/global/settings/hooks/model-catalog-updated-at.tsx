import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";

/**
 * Single source of truth for the model-catalog updated-at marker.
 *
 * Two surfaces need this value: `__root.tsx` syncs it to the host
 * runtime over IPC, and `useModelCatalog` (Settings → Models, sidebar
 * model picker) uses it as a cache-key bust. Convex de-dupes identical
 * `useQuery` calls client-side, but having both surfaces declare their
 * own subscription is logically redundant — the provider keeps a single
 * watcher open and fans the value out via context.
 */
const ModelCatalogUpdatedAtContext = createContext<number | null>(null);

export function ModelCatalogUpdatedAtProvider({
  children,
}: {
  children: ReactNode;
}) {
  const updatedAt =
    (useQuery(api.stella_models.getModelCatalogUpdatedAt, {}) as
      | number
      | undefined) ?? null;

  const lastSentRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (updatedAt === null || lastSentRef.current === updatedAt) return;
    lastSentRef.current = updatedAt;
    void window.electronAPI?.system
      ?.setModelCatalogUpdatedAt?.({ updatedAt })
      ?.catch(() => undefined);
  }, [updatedAt]);

  return (
    <ModelCatalogUpdatedAtContext.Provider value={updatedAt}>
      {children}
    </ModelCatalogUpdatedAtContext.Provider>
  );
}

/** Read the current catalog updated-at marker; `null` until first load. */
export function useModelCatalogUpdatedAt(): number | null {
  return useContext(ModelCatalogUpdatedAtContext);
}
