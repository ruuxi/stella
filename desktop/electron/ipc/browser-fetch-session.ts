import path from "node:path";
import { BrowserSession } from "../../../runtime/kernel/browser-use/client.js";
import { getStellaBrowserBridgeEnv } from "../../../runtime/kernel/tools/stella-browser-bridge-config.js";
import { resolveStellaBrowserRoot } from "../utils/stella-browser-paths.js";
import { PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS } from "./renderer-safe-url.js";

type BrowserCookie = {
  name: string;
  value: string;
};

/**
 * Stable command owner for all privileged renderer fetches.
 *
 * The Stella Browser extension (≤1.2.6) creates a fresh `about:blank` owner
 * tab as a side effect of `cookies_get` whenever the command owner has no
 * tabs yet, and only reaps owner tabs after 24 hours of inactivity. The old
 * one-shot `BrowserSession(randomUUID())` per fetch therefore leaked one
 * blank tab per `browser:fetchJson`/`browser:fetchText` call — apps that
 * poll an API (e.g. Tower Reader loading MangaDex/Atsumaru chapters) piled
 * up dozens of blank spinner tabs.
 *
 * Reusing one owner bounds the side effect to at most a single blank tab,
 * and the idle reaper below finalizes (closes) that tab shortly after the
 * fetch burst ends.
 */
const FETCH_OWNER_ID = "stella-desktop-privileged-fetch";

/** How long after the last fetch the owner's helper tab is closed. */
const IDLE_TAB_REAP_MS = 10_000;

let sharedSession: BrowserSession | null = null;
let reapTimer: NodeJS.Timeout | null = null;
let lastLeaseIssuedAt = 0;

const createSession = (): BrowserSession => {
  const stellaBrowserRoot = resolveStellaBrowserRoot();
  // The extension tracks one lease per owner and rejects a lease whose
  // timestamp is not strictly newer than the last one it accepted. Sessions
  // for this stable owner are recreated after errors and idle reaps, so keep
  // the issued-at strictly monotonic even within one millisecond.
  lastLeaseIssuedAt = Math.max(Date.now(), lastLeaseIssuedAt + 1);
  return new BrowserSession({
    sessionId: FETCH_OWNER_ID,
    cwd: stellaBrowserRoot,
    binaryPath: path.join(stellaBrowserRoot, "bin", "stella-browser.js"),
    env: { ...getStellaBrowserBridgeEnv() },
    commandTimeoutMs: PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS,
    ownerLeaseIssuedAt: lastLeaseIssuedAt,
  });
};

const getSharedSession = (): BrowserSession => {
  if (!sharedSession || sharedSession.isDisposed) {
    sharedSession = createSession();
  }
  return sharedSession;
};

const dropSharedSession = (session: BrowserSession): void => {
  if (sharedSession === session) sharedSession = null;
  void session.dispose().catch(() => {});
};

/**
 * Close the shared owner's helper tab(s) and transport. Best-effort: a
 * wedged bridge must never propagate out of the reaper.
 */
export const reapBrowserFetchTabs = async (): Promise<void> => {
  if (reapTimer) {
    clearTimeout(reapTimer);
    reapTimer = null;
  }
  const session = sharedSession;
  if (!session) return;
  sharedSession = null;
  try {
    await session.command("finalize_tabs", { keep: [] });
  } catch {
    // Tab cleanup is best-effort; the extension's stale-tab reaper is the
    // 24h backstop.
  }
  await session.dispose().catch(() => {});
};

const scheduleReap = (): void => {
  if (reapTimer) clearTimeout(reapTimer);
  reapTimer = setTimeout(() => {
    reapTimer = null;
    void reapBrowserFetchTabs();
  }, IDLE_TAB_REAP_MS);
  reapTimer.unref?.();
};

export const getBrowserCookieHeader = async (
  targetUrl: string,
): Promise<string | null> => {
  const session = getSharedSession();
  try {
    const response = await session.command<{ cookies?: BrowserCookie[] }>(
      "cookies_get",
      { url: targetUrl },
    );
    const cookies = response.result.data?.cookies ?? [];
    if (cookies.length === 0) return null;
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch (error) {
    // Do not reuse a session after a failure: transport wedges and protocol
    // errors must not poison subsequent fetches.
    dropSharedSession(session);
    throw error;
  } finally {
    scheduleReap();
  }
};
