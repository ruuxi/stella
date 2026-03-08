import { useEffect, useMemo, useRef } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/api";
import {
  deployAndStartLocalBridge,
  type BridgeProvider,
} from "@/lib/bridge-local";

const BRIDGE_PROVIDERS: BridgeProvider[] = ["whatsapp", "signal"];

export function useBridgeAutoReconnect() {
  const getBridgeBundle = useAction(api.channels.bridge_actions.getBridgeBundle);
  const reconnectingRef = useRef<Set<string>>(new Set());

  const whatsappSession = useQuery(api.channels.bridge.getBridgeStatus, { provider: "whatsapp" });
  const signalSession = useQuery(api.channels.bridge.getBridgeStatus, { provider: "signal" });

  const sessionsByProvider: Record<BridgeProvider, typeof whatsappSession> = useMemo(
    () => ({
      whatsapp: whatsappSession,
      signal: signalSession,
    }),
    [signalSession, whatsappSession],
  );

  useEffect(() => {
    let cancelled = false;
    const electronApi = window.electronAPI;
    if (!electronApi) return;

    for (const provider of BRIDGE_PROVIDERS) {
      const session = sessionsByProvider[provider];
      if (!session) continue;

      const sessionMode = (session as Record<string, unknown>).mode as string | undefined;
      if (sessionMode !== "local") continue;

      const status = session.status;

      // If session is active but process isn't running, restart it
      if (status === "connected" || status === "awaiting_auth" || status === "initializing") {
        if (reconnectingRef.current.has(provider)) continue;

        electronApi.system.bridgeStatus({ provider }).then(async (result) => {
          if (cancelled) return;
          if (result.running) return;
          if (reconnectingRef.current.has(provider)) return;

          reconnectingRef.current.add(provider);
          try {
            await deployAndStartLocalBridge(provider, getBridgeBundle);
          } catch (err) {
            if (cancelled) return;
            console.error(`[bridge-reconnect] Failed to restart ${provider}:`, (err as Error).message);
          } finally {
            reconnectingRef.current.delete(provider);
          }
        });
      }

      // If session is stopped/error and local, clean up any orphaned process
      if (status === "stopped" || status === "error") {
        electronApi.system.bridgeStop({ provider }).catch((err) => {
          if (cancelled) return;
          console.debug(`[bridge-reconnect] Failed to stop orphaned ${provider} process:`, (err as Error).message);
        });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [getBridgeBundle, sessionsByProvider]);
}
