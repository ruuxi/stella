import { useCallback, useEffect, useRef, useState } from "react";

const WS_URL = "ws://127.0.0.1:17710";
const RECONNECT_INTERVAL_MS = 2000;

export type DevEvent = {
  type: "agent-event" | "ipc-call" | "app-lifecycle" | "log";
  ts: number;
  payload: unknown;
};

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export function useDevToolSocket() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [events, setEvents] = useState<DevEvent[]>([]);
  const [stellaHomePath, setStellaHomePath] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus("connecting");
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (mountedRef.current) setStatus("connected");
    };

    ws.onmessage = (e) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(e.data as string);

        if (msg.type === "connected") {
          setStellaHomePath(msg.stellaHomePath ?? null);
          return;
        }

        if (msg.type === "event" && msg.event) {
          setEvents((prev) => {
            const next = [...prev, msg.event as DevEvent];
            // Keep last 2000 events in memory
            return next.length > 2000 ? next.slice(-2000) : next;
          });
          return;
        }

        if (msg.type === "command-result") {
          // Could surface these in UI — for now just log
          console.log("[devtool] command result:", msg);
          return;
        }

        if (msg.type === "error") {
          console.error("[devtool] server error:", msg.message);
        }
      } catch {
        // ignore bad messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setStatus("disconnected");
      wsRef.current = null;
      // Auto-reconnect
      reconnectTimer.current = setTimeout(connect, RECONNECT_INTERVAL_MS);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendCommand = useCallback((command: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ command }));
    }
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return { status, events, stellaHomePath, sendCommand, clearEvents };
}
