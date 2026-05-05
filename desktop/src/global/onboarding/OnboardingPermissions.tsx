import { useCallback, useEffect, useRef } from "react";
import {
  useDesktopPermissions,
  type DesktopPermissionKind,
  type DesktopPermissionStatus,
} from "@/global/permissions/use-desktop-permissions";
import { useMicrophoneRecovery } from "@/global/permissions/use-microphone-recovery";

type PermissionKind = DesktopPermissionKind;
type PermissionStatus = DesktopPermissionStatus;

type PermissionCard = {
  kind: PermissionKind;
  title: string;
  description: string;
  actionLabel: string;
  requiresRelaunch?: boolean;
};

const PERMISSION_CARDS: PermissionCard[] = [
  {
    kind: "accessibility",
    title: "Accessibility",
    description:
      "Lets Stella open the quick menu (⌘/Ctrl + right-click), read selected text, and interact with what is under the cursor.",
    actionLabel: "Enable",
  },
  {
    kind: "screen",
    title: "Screen Capture",
    description:
      "Lets Stella capture screenshots and window content for capture and vision tasks.",
    actionLabel: "Enable",
    requiresRelaunch: true,
  },
  {
    kind: "microphone",
    title: "Microphone",
    description: "Needed for voice conversations.",
    actionLabel: "Enable",
  },
];

const POLL_INTERVAL_MS = 3000;
const INITIAL_PERMISSION_STATUS: PermissionStatus = {
  accessibility: false,
  screen: false,
  microphone: false,
  microphoneStatus: "unknown",
};
const ONBOARDING_RESTART_KINDS = PERMISSION_CARDS.filter(
  (card) => card.requiresRelaunch,
).map((card) => card.kind);

type OnboardingPermissionsProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

const requestOnboardingScreenAccess = async () => {
  const result = await window.electronAPI?.system.requestPermission?.("screen");
  if (result?.granted) {
    return { granted: true, openedSettings: false };
  }

  let openedSettings = Boolean(result?.openedSettings);
  if (!result?.openedSettings) {
    await window.electronAPI?.system.openPermissionSettings?.("screen");
    openedSettings = true;
  }
  return { granted: false, openedSettings };
};

const requestMicrophoneForOnboarding = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
};

export function OnboardingPermissions({
  splitTransitionActive,
  onContinue,
}: OnboardingPermissionsProps) {
  /** Windows/Linux: main process cannot read mic TCC; set after successful getUserMedia. */
  const micSessionGrantedRef = useRef(false);
  const screenSettingsOpenedRef = useRef(false);
  const screenRestartPendingRef = useRef(false);
  const normalizeOnboardingStatus = useCallback(
    (result: PermissionStatus) => ({
      ...result,
      screen: result.screen || screenRestartPendingRef.current,
      microphone: result.microphone || micSessionGrantedRef.current,
    }),
    [],
  );
  const {
    status,
    activeAction: requesting,
    setActiveAction: setRequesting,
    restartRecommended,
    isRestarting,
    refresh: fetchStatus,
    requestWithSettingsFallback,
    restart: handleRestart,
  } = useDesktopPermissions({
    pollMs: POLL_INTERVAL_MS,
    initialStatus: INITIAL_PERMISSION_STATUS,
    restartKinds: ONBOARDING_RESTART_KINDS,
    normalizeStatus: normalizeOnboardingStatus,
  });
  const microphoneRecovery = useMicrophoneRecovery();
  const isClosing = isRestarting || microphoneRecovery.isResetting;

  const platform = window.electronAPI?.platform;
  const microphoneDenied =
    platform === "darwin" && status.microphoneStatus === "denied";

  useEffect(() => {
    if (platform !== "darwin") return;

    const markScreenPendingAfterSettingsReturn = () => {
      if (
        !screenSettingsOpenedRef.current ||
        screenRestartPendingRef.current ||
        document.visibilityState === "hidden"
      ) {
        return;
      }

      void fetchStatus().then((latestStatus) => {
        if (!screenSettingsOpenedRef.current || latestStatus?.screen) {
          screenSettingsOpenedRef.current = false;
          return;
        }

        screenRestartPendingRef.current = true;
        screenSettingsOpenedRef.current = false;
        void fetchStatus();
      });
    };

    window.addEventListener("focus", markScreenPendingAfterSettingsReturn);
    document.addEventListener(
      "visibilitychange",
      markScreenPendingAfterSettingsReturn,
    );

    return () => {
      window.removeEventListener("focus", markScreenPendingAfterSettingsReturn);
      document.removeEventListener(
        "visibilitychange",
        markScreenPendingAfterSettingsReturn,
      );
    };
  }, [fetchStatus, platform]);

  const handleEnable = useCallback(
    async (card: PermissionCard) => {
      setRequesting(card.kind);
      try {
        if (card.kind === "screen") {
          const result = await requestOnboardingScreenAccess();
          if (result.openedSettings && !result.granted) {
            screenSettingsOpenedRef.current = true;
          }
          await fetchStatus();
          return;
        }

        if (card.kind === "microphone") {
          if (microphoneDenied) {
            await window.electronAPI?.system.openPermissionSettings?.(
              "microphone",
            );
            await fetchStatus();
            return;
          }
          try {
            await requestMicrophoneForOnboarding();
            micSessionGrantedRef.current = true;
          } catch {
            const latestStatus = await fetchStatus();
            if (latestStatus?.microphoneStatus !== "denied") {
              await window.electronAPI?.system.openPermissionSettings?.(
                "microphone",
              );
            }
          }
          await fetchStatus();
          return;
        }

        await requestWithSettingsFallback(card.kind);
        await fetchStatus();
      } catch {
        await fetchStatus();
      } finally {
        setRequesting(null);
      }
    },
    [fetchStatus, microphoneDenied, requestWithSettingsFallback, setRequesting],
  );

  const allMeasuredGranted =
    status.accessibility && status.screen && status.microphone;
  const showRestartButton =
    restartRecommended &&
    PERMISSION_CARDS.some((card) => card.requiresRelaunch && status[card.kind]);
  const showMicrophoneRecovery =
    platform === "darwin" && status.microphoneStatus === "denied";

  return (
    <div className="onboarding-step-content">
      <div className="onboarding-step-label">Permissions</div>
      <p className="onboarding-step-desc">
        Stella works best with a few things turned on up front.
      </p>

      <div className="onboarding-permissions-list">
        {PERMISSION_CARDS.map((card) => {
          const granted = status[card.kind];

          let actionLabel = card.actionLabel;
          if (granted) {
            actionLabel = "Granted \u2713";
          } else if (card.kind === "microphone" && microphoneDenied) {
            actionLabel = "Open Settings";
          } else if (requesting === card.kind) {
            actionLabel = "Opening\u2026";
          }

          const detailParts = [
            card.requiresRelaunch
              ? "You may need to reopen Stella after enabling it"
              : null,
            card.kind === "microphone" && microphoneDenied
              ? "Previously denied on this Mac"
              : null,
          ].filter(Boolean);

          return (
            <div
              key={card.kind}
              className="onboarding-permission-card"
              data-granted={granted || undefined}
            >
              <div className="onboarding-permission-card__info">
                <span className="onboarding-permission-card__title">
                  {card.title}
                </span>
                <span className="onboarding-permission-card__desc">
                  {card.description}
                </span>
                {detailParts.length > 0 ? (
                  <span className="onboarding-permission-card__meta">
                    {detailParts.join(" · ")}
                  </span>
                ) : null}
              </div>
              <button
                className="onboarding-permission-card__action"
                onClick={() => void handleEnable(card)}
                disabled={granted || requesting === card.kind}
              >
                {actionLabel}
              </button>
            </div>
          );
        })}
      </div>

      {showMicrophoneRecovery ? (
        <div className="onboarding-permissions-restart">
          <span className="onboarding-permission-card__meta">
            Microphone access was denied earlier, so macOS will not prompt
            Stella again automatically. Reset it, then reopen Stella from the
            launcher.
          </span>
          <div className="onboarding-permissions-actions">
            <button
              className="onboarding-permission-card__action"
              disabled={isClosing}
              onClick={microphoneRecovery.openSettings}
            >
              Open Settings
            </button>
            <button
              className="onboarding-confirm"
              data-visible={true}
              disabled={isClosing}
              onClick={() => void microphoneRecovery.resetAndRestart()}
            >
              {isClosing ? "Closing..." : "Reset & Restart"}
            </button>
          </div>
        </div>
      ) : null}

      {showRestartButton ? (
        <div className="onboarding-permissions-restart">
          <span className="onboarding-permission-card__meta">
            macOS needs Stella to close before this permission takes effect.
            After it closes, reopen Stella from the launcher.
          </span>
          <button
            className="onboarding-confirm"
            data-visible={true}
            disabled={isClosing}
            onClick={() => void handleRestart()}
          >
            {isClosing ? "Closing..." : "Restart"}
          </button>
        </div>
      ) : null}

      <button
        className="onboarding-confirm"
        data-visible={true}
        disabled={splitTransitionActive || isClosing}
        onClick={onContinue}
      >
        {allMeasuredGranted ? "Continue" : "Skip for now"}
      </button>
    </div>
  );
}
