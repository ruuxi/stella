/**
 * Bridges Vite's HMR error stream into Stella's renderer `ErrorBoundary` /
 * `CrashSurface`. Vite's built-in red overlay is disabled in `vite.config.ts`
 * (`server.hmr.overlay: false`); we forward the `vite:error` payload through
 * `window` CustomEvents so build / parse errors get the same Reload / Ask
 * Stella to repair / Undo latest update controls as runtime crashes.
 */

type ViteErrorLoc = {
  file?: string;
  line?: number;
  column?: number;
};

type ViteErrorPayloadErr = {
  message?: string;
  stack?: string;
  id?: string;
  plugin?: string;
  frame?: string;
  loc?: ViteErrorLoc;
};

type ViteErrorPayload = {
  type: "error";
  err: ViteErrorPayloadErr;
};

export type StellaBuildErrorDetail = {
  error: Error;
  plugin: string | null;
  file: string | null;
  loc: ViteErrorLoc | null;
  frame: string | null;
};

export const STELLA_BUILD_ERROR_EVENT = "stella:build-error";
export const STELLA_BUILD_ERROR_CLEARED_EVENT = "stella:build-error-cleared";

const formatLocation = (
  id: string | undefined,
  loc: ViteErrorLoc | undefined,
): string | null => {
  const file = loc?.file ?? id;
  if (!file) return null;
  if (loc?.line != null) {
    const column = loc.column != null ? `:${loc.column}` : "";
    return `${file}:${loc.line}${column}`;
  }
  return file;
};

const buildErrorFromPayload = (err: ViteErrorPayloadErr): Error => {
  const location = formatLocation(err.id, err.loc);
  const pluginPrefix = err.plugin ? `[${err.plugin}] ` : "";
  const baseMessage = err.message?.trim() || "Build error";
  const message = location
    ? `${pluginPrefix}${baseMessage}\n  at ${location}`
    : `${pluginPrefix}${baseMessage}`;
  const built = new Error(message);
  built.name = err.plugin ? `BuildError(${err.plugin})` : "BuildError";
  if (err.stack) built.stack = err.stack;
  return built;
};

const dispatchBuildError = (payload: ViteErrorPayload) => {
  const detail: StellaBuildErrorDetail = {
    error: buildErrorFromPayload(payload.err ?? {}),
    plugin: payload.err?.plugin ?? null,
    file: payload.err?.loc?.file ?? payload.err?.id ?? null,
    loc: payload.err?.loc ?? null,
    frame: payload.err?.frame ?? null,
  };
  window.dispatchEvent(
    new CustomEvent<StellaBuildErrorDetail>(STELLA_BUILD_ERROR_EVENT, {
      detail,
    }),
  );
};

const dispatchCleared = () => {
  window.dispatchEvent(new CustomEvent(STELLA_BUILD_ERROR_CLEARED_EVENT));
};

if (import.meta.hot) {
  import.meta.hot.on("vite:error", (payload: ViteErrorPayload) => {
    try {
      dispatchBuildError(payload);
    } catch (dispatchError) {
      console.error(
        "[vite-error-recovery] dispatch failed:",
        dispatchError,
        payload,
      );
    }
  });

  import.meta.hot.on("vite:beforeUpdate", () => {
    dispatchCleared();
  });

  import.meta.hot.on("vite:beforeFullReload", () => {
    dispatchCleared();
  });
}
