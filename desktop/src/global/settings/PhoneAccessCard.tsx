import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import QRCode from "qrcode";
import { api } from "@/convex/api";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { Button } from "@/ui/button";

type PairingSessionState = {
  pairingCode: string;
  expiresAt: number;
  createdAt: number;
} | null;

type PairedPhoneRecord = {
  mobileDeviceId: string;
  displayName?: string;
  platform?: string;
  approvedAt: number;
  lastSeenAt: number;
};

const formatTimestamp = (value: number) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);

const formatCountdown = (expiresAt: number) => {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) {
    return "Expired";
  }
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")} left`;
};

export function PhoneAccessCard() {
  const { hasConnectedAccount } = useAuthSessionState();
  const [desktopDeviceId, setDesktopDeviceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [removingMobileDeviceId, setRemovingMobileDeviceId] = useState<
    string | null
  >(null);
  const [copiedValue, setCopiedValue] = useState<"code" | "link" | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const createPairingSession = useMutation(
    api.mobile_access.createPairingSession,
  );
  const revokePairedMobileDevice = useMutation(
    api.mobile_access.revokePairedMobileDevice,
  );

  useEffect(() => {
    if (!hasConnectedAccount) {
      setDesktopDeviceId(null);
      return;
    }

    let cancelled = false;
    const loadDeviceId = async () => {
      try {
        const nextDeviceId = await window.electronAPI?.system.getDeviceId();
        if (!cancelled) {
          setDesktopDeviceId(nextDeviceId ?? null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Unable to prepare phone access on this desktop.",
          );
        }
      }
    };
    void loadDeviceId();
    return () => {
      cancelled = true;
    };
  }, [hasConnectedAccount]);

  useEffect(() => {
    if (!copiedValue) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setCopiedValue(null);
    }, 1_500);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copiedValue]);

  const hasActivePairing = Boolean(phoneAccessState?.activePairing);

  useEffect(() => {
    if (!hasActivePairing) {
      return;
    }
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasActivePairing]);

  const phoneAccessState = useQuery(
    api.mobile_access.getPhoneAccessState,
    hasConnectedAccount && desktopDeviceId ? { desktopDeviceId } : "skip",
  ) as
    | {
        activePairing: PairingSessionState;
        pairedDevices: PairedPhoneRecord[];
      }
    | undefined;

  const activePairing = useMemo(() => {
    const pairing = phoneAccessState?.activePairing ?? null;
    if (!pairing || pairing.expiresAt <= now) {
      return null;
    }
    return pairing;
  }, [now, phoneAccessState?.activePairing]);

  const pairingLink = activePairing
    ? `stella-mobile://stella?code=${encodeURIComponent(activePairing.pairingCode)}`
    : null;

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!pairingLink) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(pairingLink, {
      width: 160,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [pairingLink]);

  const copyText = useCallback(async (value: string, kind: "code" | "link") => {
    await navigator.clipboard.writeText(value);
    setCopiedValue(kind);
  }, []);

  const handleCreatePairing = useCallback(async () => {
    if (!desktopDeviceId || isCreating) {
      return;
    }
    setError(null);
    setIsCreating(true);
    try {
      await createPairingSession({ desktopDeviceId });
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to create a pairing code right now.",
      );
    } finally {
      setIsCreating(false);
    }
  }, [createPairingSession, desktopDeviceId, isCreating]);

  const handleRemovePhone = useCallback(
    async (mobileDeviceId: string) => {
      if (!desktopDeviceId || removingMobileDeviceId) {
        return;
      }
      setError(null);
      setRemovingMobileDeviceId(mobileDeviceId);
      try {
        await revokePairedMobileDevice({ desktopDeviceId, mobileDeviceId });
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Unable to remove this phone right now.",
        );
      } finally {
        setRemovingMobileDeviceId(null);
      }
    },
    [desktopDeviceId, removingMobileDeviceId, revokePairedMobileDevice],
  );

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3 className="settings-card-title">Phone Access</h3>
        <Button
          type="button"
          variant="ghost"
          className="settings-btn"
          onClick={() => void handleCreatePairing()}
          disabled={!hasConnectedAccount || !desktopDeviceId || isCreating}
        >
          {isCreating
            ? "Preparing..."
            : activePairing
              ? "Refresh Code"
              : "Pair a Phone"}
        </Button>
      </div>
      <p className="settings-card-desc">
        Pair your phone once, then it can reconnect to this desktop without
        asking again.
      </p>
      {!hasConnectedAccount ? (
        <p className="settings-card-desc">Sign in to pair your phone.</p>
      ) : null}
      {error ? (
        <p
          className="settings-card-desc settings-card-desc--error"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {activePairing ? (
        <div className="settings-phone-pairing">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="Scan to pair your phone"
              className="settings-phone-qr"
            />
          ) : null}
          <div className="settings-phone-code-block">
            <div className="settings-phone-code-label">
              {qrDataUrl
                ? "Scan with your phone, or enter this code"
                : "Enter this code on your phone"}
            </div>
            <div className="settings-phone-code">
              {activePairing.pairingCode}
            </div>
            <div className="settings-phone-code-meta">
              <span>{formatCountdown(activePairing.expiresAt)}</span>
              <span>Created {formatTimestamp(activePairing.createdAt)}</span>
            </div>
          </div>
          <div className="settings-phone-actions">
            <Button
              type="button"
              variant="ghost"
              className="settings-btn"
              onClick={() => void copyText(activePairing.pairingCode, "code")}
            >
              {copiedValue === "code" ? "Copied" : "Copy Code"}
            </Button>
            {pairingLink ? (
              <Button
                type="button"
                variant="ghost"
                className="settings-btn"
                onClick={() => void copyText(pairingLink, "link")}
              >
                {copiedValue === "link" ? "Copied" : "Copy Pairing Link"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">One-time pairing</div>
            <div className="settings-row-sublabel">
              Create a short code here, then enter it in the Stella app on your
              phone.
            </div>
          </div>
        </div>
      )}

      <div className="settings-phone-list">
        {phoneAccessState?.pairedDevices?.length ? (
          phoneAccessState.pairedDevices.map((phone) => (
            <div key={phone.mobileDeviceId} className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-label">
                  {phone.displayName?.trim() || "Trusted phone"}
                </div>
                <div className="settings-row-sublabel">
                  {phone.platform?.trim() || "Phone"} paired{" "}
                  {formatTimestamp(phone.approvedAt)}
                </div>
                <div className="settings-row-sublabel">
                  Last used {formatTimestamp(phone.lastSeenAt)}
                </div>
              </div>
              <div className="settings-row-control">
                <Button
                  type="button"
                  variant="ghost"
                  className="settings-btn settings-btn--danger"
                  onClick={() => void handleRemovePhone(phone.mobileDeviceId)}
                  disabled={removingMobileDeviceId === phone.mobileDeviceId}
                >
                  {removingMobileDeviceId === phone.mobileDeviceId
                    ? "Removing..."
                    : "Remove"}
                </Button>
              </div>
            </div>
          ))
        ) : (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">No paired phones yet</div>
              <div className="settings-row-sublabel">
                Once you pair a phone here, future connections can start from
                your phone.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
