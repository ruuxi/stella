/** Backend Composio account-status checks shared by desktop and runtime. */

export type BackendIntegrationProbeResult =
  | "connected"
  | "not_connected"
  | "unsupported"
  | "error";

export type BackendIntegrationWaitResult =
  | "connected"
  | "timeout"
  | "cancelled"
  | "unsupported"
  | "auth_unavailable";

const readConnected = (payload: unknown): boolean =>
  Boolean(
    payload &&
      typeof payload === "object" &&
      (payload as { connected?: unknown }).connected === true,
  );

export const probeBackendIntegrationConnection = async (options: {
  siteUrl: string;
  authToken: string;
  id: string;
  fetchImpl?: typeof fetch;
}): Promise<BackendIntegrationProbeResult> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.siteUrl.trim().replace(/\/+$/u, "");
  if (!base || !options.authToken.trim()) return "error";
  const response = await fetchImpl(
    `${base}/api/native-integrations/status?id=${encodeURIComponent(options.id)}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.authToken}`,
      },
    },
  ).catch(() => null);
  if (!response) return "error";
  if (response.status === 404 || response.status === 405) return "unsupported";
  if (!response.ok) return "error";
  const payload = (await response.json().catch(() => null)) as unknown;
  return readConnected(payload) ? "connected" : "not_connected";
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });

export const waitForBackendIntegrationConnection = async (options: {
  siteUrl: string;
  authToken: string;
  id: string;
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<BackendIntegrationWaitResult> => {
  if (!options.siteUrl.trim() || !options.authToken.trim()) {
    return "auth_unavailable";
  }
  const timeoutMs = options.timeoutMs ?? 4 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 2_500;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    if (options.signal?.aborted) return "cancelled";
    const result = await probeBackendIntegrationConnection(options);
    if (result === "connected") return "connected";
    if (result === "unsupported") return "unsupported";
    if (options.signal?.aborted) return "cancelled";
    if (now() >= deadline) return "timeout";
    await sleep(intervalMs, options.signal);
  }
};
