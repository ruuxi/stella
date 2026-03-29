import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";

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
  const lastHandledIntentIdRef = useRef<string | null>(null);

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
        const nextDeviceId = await window.electronAPI?.system.getDeviceId();
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
    if (lastHandledIntentIdRef.current === intent.intentId) {
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        await window.electronAPI!.system.startPhoneAccessSession();
        await acknowledgeIntent({ intentId: intent.intentId });
        if (!cancelled) {
          lastHandledIntentIdRef.current = intent.intentId;
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
