/**
 * Wiring for the "canvas share" feature (publish a canvas to a public URL,
 * list your active shares, revoke them).
 *
 * The Convex function references are declared with `makeFunctionReference`
 * rather than reaching into the generated `api` object, so the desktop side
 * is decoupled from when the backend regenerates the shared API type — only
 * the module paths below need to match what the backend deploys.
 *
 * The provider is mounted once inside the main app tree (under the Convex
 * provider). It is intentionally absent from the mini window, which has no
 * Convex provider; consumers read `useCanvasShare()` and render nothing when
 * it returns `null`, so the shared canvas renderer never calls Convex hooks
 * outside a provider.
 *
 * Backend contract:
 *   publish({ html, title? }) -> { url, slug, expiresAt }
 *   revoke({ slug })          -> null
 *   listMine()                -> SharedCanvasLink[]
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useConvex, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { canvasShareBaseUrl } from "@/shared/lib/canvas-share";

export type PublishedCanvasShare = {
  url: string;
  slug: string;
  expiresAt: number;
};

export type SharedCanvasLink = {
  slug: string;
  url: string;
  title: string | null;
  createdAt: number;
  expiresAt: number;
};

const canvasSharePublishRef = makeFunctionReference<
  "mutation",
  { html: string; title?: string },
  PublishedCanvasShare
>("canvas_shares:publish");

const canvasShareRevokeRef = makeFunctionReference<
  "mutation",
  { slug: string },
  null
>("canvas_shares:revoke");

const canvasShareListMineRef = makeFunctionReference<
  "query",
  Record<string, never>,
  SharedCanvasLink[]
>("canvas_shares:listMine");

export type CanvasShareContextValue = {
  /** Public base URL for share links, or null when the domain is pending. */
  baseUrl: string | null;
  publish: (args: {
    html: string;
    title?: string;
  }) => Promise<PublishedCanvasShare>;
  revoke: (args: { slug: string }) => Promise<void>;
  listMine: () => Promise<SharedCanvasLink[]>;
  /** Bumps after a publish/revoke so list views can refetch. */
  version: number;
};

const CanvasShareContext = createContext<CanvasShareContextValue | null>(null);

export function CanvasShareProvider({ children }: { children: ReactNode }) {
  const convex = useConvex();
  const publishMutation = useMutation(canvasSharePublishRef);
  const revokeMutation = useMutation(canvasShareRevokeRef);
  const [version, setVersion] = useState(0);
  const baseUrl = useMemo(() => canvasShareBaseUrl(), []);

  const publish = useCallback(
    async (args: { html: string; title?: string }) => {
      const result = await publishMutation(args);
      setVersion((current) => current + 1);
      return result;
    },
    [publishMutation],
  );

  const revoke = useCallback(
    async ({ slug }: { slug: string }) => {
      await revokeMutation({ slug });
      setVersion((current) => current + 1);
    },
    [revokeMutation],
  );

  const listMine = useCallback(
    () => convex.query(canvasShareListMineRef, {}),
    [convex],
  );

  const value = useMemo<CanvasShareContextValue>(
    () => ({ baseUrl, publish, revoke, listMine, version }),
    [baseUrl, publish, revoke, listMine, version],
  );

  return (
    <CanvasShareContext.Provider value={value}>
      {children}
    </CanvasShareContext.Provider>
  );
}

/**
 * Returns the canvas-share API, or `null` when rendered outside the provider
 * (e.g. the mini window). Callers must no-op / hide UI on `null`.
 */
export const useCanvasShare = (): CanvasShareContextValue | null =>
  useContext(CanvasShareContext);
