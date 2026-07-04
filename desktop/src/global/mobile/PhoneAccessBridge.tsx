import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { getDeviceIdOrNull } from "@/platform/electron/device";

const DEVICE_ID_RETRY_LIMIT = 8;
const DEVICE_ID_RETRY_BASE_DELAY_MS = 2_000;

type AcknowledgeIntentArgs = Parameters<
  ReturnType<
    typeof useMutation<typeof api.mobile_access.acknowledgeConnectIntent>
  >
>[0];

export function PhoneAccessBridge() {
  const { hasConnectedAccount } = useAuthSessionState();
  const acknowledgeIntent = useMutation(
    api.mobile_access.acknowledgeConnectIntent,
  );
  const [desktopDeviceId, setDesktopDeviceId] = useState<string | null>(null);
  const lastHandledIntentKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hasConnectedAccount) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    let attempts = 0;

    const loadDeviceId = async () => {
      if (cancelled || attempts >= DEVICE_ID_RETRY_LIMIT) {
        return;
      }
      attempts += 1;

      try {
        const nextDeviceId = await getDeviceIdOrNull();
        if (cancelled) {
          return;
        }
        if (nextDeviceId) {
          setDesktopDeviceId(nextDeviceId);
          return;
        }
      } catch (error) {
        if (!cancelled && attempts >= DEVICE_ID_RETRY_LIMIT) {
          console.warn(
            "[phone-access] Failed to load desktop device id:",
            error,
          );
        }
      }

      if (!cancelled && attempts < DEVICE_ID_RETRY_LIMIT) {
        timeoutId = window.setTimeout(() => {
          void loadDeviceId();
        }, DEVICE_ID_RETRY_BASE_DELAY_MS * attempts);
      }
    };

    void loadDeviceId();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [hasConnectedAccount]);

  // Omit `nowMs` so this subscription stays reactively cacheable on the
  // backend (a per-tick client clock would bust Convex's cache every poll).
  // The query returns `expiresAt`; expiry is checked client-side below.
  const intent = useQuery(
    api.mobile_access.watchIncomingConnectIntent,
    hasConnectedAccount && desktopDeviceId ? { desktopDeviceId } : "skip",
  ) as
    | {
        intentId: AcknowledgeIntentArgs["intentId"];
        mobileDeviceId: string;
        createdAt: number;
        expiresAt: number;
      }
    | null
    | undefined;

  useEffect(() => {
    if (
      !intent?.intentId ||
      !window.electronAPI?.system.startPhoneAccessSession
    ) {
      return;
    }
    // Gate on the backend-provided expiry instead of passing a client clock
    // into the query: ignore intents that have already lapsed.
    if (
      typeof intent.expiresAt === "number" &&
      Date.now() > intent.expiresAt
    ) {
      return;
    }
    const intentKey = `${intent.intentId}:${intent.createdAt}`;
    if (lastHandledIntentKeyRef.current === intentKey) {
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        await window.electronAPI!.system.startPhoneAccessSession();
        await acknowledgeIntent({ intentId: intent.intentId });
        if (!cancelled) {
          lastHandledIntentKeyRef.current = intentKey;
        }
      } catch (error) {
        console.warn("[phone-access] Failed to activate session:", error);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [acknowledgeIntent, intent]);

  return null;
}
