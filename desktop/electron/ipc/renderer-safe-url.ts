import { normalizeSafeExternalUrl } from "../../../runtime/kernel/tools/network-guards.js";

/** Same budget as browser-backed fetch (`browser:fetchJson` / `browser:fetchText`). */
export const PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS = 30_000;

/**
 * Validates and normalizes a URL before any main-process `fetch` driven by privileged
 * renderer IPC. Keeps SSRF policy aligned across handlers (not only `browser:fetch*`).
 */
export async function normalizeUrlForPrivilegedRendererFetch(
  inputUrl: string,
): Promise<string> {
  return normalizeSafeExternalUrl(inputUrl, {
    skipResolvedAddressCheck: process.env.NODE_ENV === "development",
  });
}
