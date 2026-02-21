/**
 * Local HTTP + SSE client for communicating with the local server.
 * Replaces Convex client queries/mutations in local mode.
 */

const DEFAULT_PORT = 9714;
const MODE_CACHE_KEY = "Stella.dataMode";

let localPort: number = DEFAULT_PORT;

export function setLocalPort(port: number): void {
  localPort = port;
}

export function getLocalPort(): number {
  return localPort;
}

function baseUrl(): string {
  return `http://localhost:${localPort}`;
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

export async function localGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function localPost<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function localPut<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function localPatch<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function localDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── SSE Client ──────────────────────────────────────────────────────────────

export type SSEListener = {
  onEvent: (event: string, data: unknown) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
};

export class LocalSSEClient {
  private eventSource: EventSource | null = null;
  private conversationId: string;
  private listeners = new Set<SSEListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  connect(): void {
    if (this.eventSource) return;

    const url = `${baseUrl()}/api/sse?conversationId=${encodeURIComponent(this.conversationId)}`;
    this.eventSource = new EventSource(url);

    // Listen to all named events
    const eventTypes = [
      "event_added",
      "task_updated",
      "streaming_text",
      "streaming_done",
      "suggestions",
      "ping",
    ];

    for (const type of eventTypes) {
      this.eventSource.addEventListener(type, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          for (const listener of this.listeners) {
            listener.onEvent(type, data);
          }
        } catch {
          // Ignore parse errors
        }
      });
    }

    this.eventSource.onerror = () => {
      for (const listener of this.listeners) {
        listener.onError?.(new Error("SSE connection error"));
      }
      // Auto-reconnect after 3 seconds
      this.disconnect();
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  addListener(listener: SSEListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.disconnect();
      }
    };
  }

  switchConversation(conversationId: string): void {
    if (this.conversationId === conversationId) return;
    this.conversationId = conversationId;
    this.disconnect();
    if (this.listeners.size > 0) {
      this.connect();
    }
  }
}

// ─── Chat Helper ─────────────────────────────────────────────────────────────

/**
 * Start a chat via the local server.
 * Returns the streaming response directly (AI SDK UIMessageStream format).
 */
export async function localChat(params: {
  conversationId: string;
  userMessageId: string;
  agent?: string;
}): Promise<Response> {
  const res = await fetch(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res;
}

// ─── Mode Detection ──────────────────────────────────────────────────────────

export type DataMode = "local" | "cloud";

let _isElectronRuntime: boolean | null = null;

export function isElectronRuntime(): boolean {
  if (_isElectronRuntime !== null) return _isElectronRuntime;
  _isElectronRuntime = typeof window !== "undefined" && "electronAPI" in window;
  return _isElectronRuntime;
}

export function readCachedDataMode(): DataMode | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(MODE_CACHE_KEY);
  return value === "local" || value === "cloud" ? value : null;
}

export function writeCachedDataMode(mode: DataMode): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MODE_CACHE_KEY, mode);
}

export function isLocalMode(): boolean {
  if (!isElectronRuntime()) return false;
  const mode = readCachedDataMode();
  return mode ? mode === "local" : true;
}

export function setLocalMode(mode: boolean): void {
  writeCachedDataMode(mode ? "local" : "cloud");
}
