import { useCallback, useState } from "react";
import { ConnectHeroAnimation } from "@/global/integrations/ConnectHeroAnimation";
import { usePhoneAccessController } from "@/global/settings/hooks/use-phone-access-controller";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

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

export function PhoneAccessConnectCard() {
  const {
    hasConnectedAccount,
    desktopDeviceId,
    deviceLoadError,
    activePairing,
    qrDataUrl,
    pairedDevices,
    isCreating,
    removingMobileDeviceId,
    createPairing,
    removePhone,
  } = usePhoneAccessController({ qrCodeWidth: 200 });
  const [error, setError] = useState<string | null>(null);
  const visibleError = error ?? deviceLoadError;

  const handleCreate = useCallback(async () => {
    setError(null);
    try {
      await createPairing();
    } catch (e) {
      setError(toErrorMessage(e, "Unable to create a pairing code."));
    }
  }, [createPairing]);

  const handleCopy = useCallback(() => {
    if (activePairing) {
      void navigator.clipboard.writeText(activePairing.pairingCode);
      showToast("Code copied to clipboard");
    }
  }, [activePairing]);

  const handleRemovePhone = useCallback(async (mobileDeviceId: string) => {
    try {
      const didRemove = await removePhone(mobileDeviceId);
      if (didRemove) {
        showToast("Phone removed");
      }
    } catch {
      showToast("Failed to remove phone");
    }
  }, [removePhone]);

  if (!hasConnectedAccount) {
    return (
      <div className="connect-detail-area">
        <div className="connect-detail-body connect-pair-centered">
          <ConnectHeroAnimation />
          <p className="connect-pair-headline">Sign in to get started</p>
          <p className="connect-pair-sub">
            Sign in to your Stella account to pair with the mobile app.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="connect-detail-area">
      <div className="connect-detail-body connect-pair-centered">
        <ConnectHeroAnimation />
        {activePairing ? (
          <>
            <p className="connect-pair-headline">Scan or enter this code</p>
            <p className="connect-pair-sub">
              Open the Stella app on your phone and scan the QR code, or type in the code below. You only need to do this once.
            </p>

            {visibleError && <div className="connect-error">{visibleError}</div>}

            <div className="connect-pair-qr-block">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Scan to pair your phone"
                  className="connect-pair-qr"
                />
              ) : (
                <div className="connect-skeleton connect-pair-qr" />
              )}
            </div>

            <div className="connect-pair-code-group">
              <span className="connect-pair-code">{activePairing.pairingCode}</span>
              <Button variant="ghost" size="small" onClick={handleCopy}>
                Copy
              </Button>
            </div>

            <span className="connect-pair-timer">
              {formatCountdown(activePairing.expiresAt)}
            </span>
          </>
        ) : (
          <>
            <p className="connect-pair-headline">Pair your phone</p>
            <p className="connect-pair-sub">
              Link the Stella mobile app to this computer so they work together. You only need to do this once.
            </p>

            {visibleError && <div className="connect-error">{visibleError}</div>}

            <Button
              variant="ghost"
              onClick={() => void handleCreate()}
              disabled={!desktopDeviceId || isCreating}
            >
              {isCreating ? "Preparing..." : "Get Code"}
            </Button>
          </>
        )}

        {pairedDevices.length > 0 && (
          <div className="connect-paired-devices">
            <span className="connect-pair-meta">
              {pairedDevices.length} phone{pairedDevices.length > 1 ? "s" : ""} paired
            </span>
            {pairedDevices.map((device) => (
              <div key={device.mobileDeviceId} className="connect-paired-device">
                <span className="connect-paired-device-name">
                  {device.displayName?.trim() || "Phone"}
                </span>
                <button
                  type="button"
                  className="connect-bot-link"
                  onClick={() => void handleRemovePhone(device.mobileDeviceId)}
                  disabled={removingMobileDeviceId === device.mobileDeviceId}
                >
                  {removingMobileDeviceId === device.mobileDeviceId ? "Removing..." : "Remove"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
