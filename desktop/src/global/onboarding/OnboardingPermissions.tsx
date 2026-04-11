import { useCallback, useEffect, useRef, useState } from "react";

type PermissionKind =
  | "accessibility"
  | "screen"
  | "microphone";

type PermissionStatus = Record<PermissionKind, boolean>;

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
      "Lets Stella open the radial dial, read selected text, and interact with what is under the cursor.",
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
    description:
      "Needed for voice conversations and always-on wake word listening.",
    actionLabel: "Enable",
  },
];

const POLL_INTERVAL_MS = 1500;

type OnboardingPermissionsProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

const requestOnboardingScreenAccess = async () => {
  const result = await window.electronAPI?.system.requestPermission?.("screen");
  if (result?.granted) {
    return true;
  }

  await window.electronAPI?.system.openPermissionSettings?.("screen");
  return false;
};

/** Mic on macOS uses the same path as the web: Chromium shows the system prompt via getUserMedia. */
const requestMicrophoneForOnboarding = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
};

export function OnboardingPermissions({
  splitTransitionActive,
  onContinue,
}: OnboardingPermissionsProps) {
  const [status, setStatus] = useState<PermissionStatus>({
    accessibility: false,
    screen: false,
    microphone: false,
  });

  /** Windows/Linux: main process cannot read mic TCC; set after successful getUserMedia. */
  const micSessionGrantedRef = useRef(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    const result = await window.electronAPI?.system.getPermissionStatus?.();
    if (result) {
      setStatus({
        accessibility: result.accessibility,
        screen: result.screen,
        microphone: result.microphone || micSessionGrantedRef.current,
      });
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    pollRef.current = setInterval(() => void fetchStatus(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus]);

  const [requesting, setRequesting] = useState<PermissionKind | null>(null);

  const handleEnable = useCallback(
    async (card: PermissionCard) => {
      setRequesting(card.kind);
      try {
        if (card.kind === "screen") {
          await requestOnboardingScreenAccess();
          await fetchStatus();
          return;
        }

        if (card.kind === "microphone") {
          try {
            await requestMicrophoneForOnboarding();
            micSessionGrantedRef.current = true;
          } catch {
            await window.electronAPI?.system.openPermissionSettings?.(
              "microphone",
            );
          }
          await fetchStatus();
          return;
        }

        await window.electronAPI?.system.requestPermission?.(card.kind);
        await fetchStatus();
      } catch {
        await fetchStatus();
      } finally {
        setRequesting(null);
      }
    },
    [fetchStatus],
  );

  const allMeasuredGranted =
    status.accessibility && status.screen && status.microphone;

  return (
    <div className="onboarding-step-content">
      <div className="onboarding-step-label">Permissions</div>
      <p className="onboarding-step-desc">
        Stella works best when these permissions are granted up front.
        Accessibility powers the radial shortcut and selected text, screen
        capture powers vision tasks, and the microphone powers voice and wake
        word.
      </p>

      <div className="onboarding-permissions-list">
        {PERMISSION_CARDS.map((card) => {
          const granted = status[card.kind];

          let actionLabel = card.actionLabel;
          if (granted) {
            actionLabel = "Granted \u2713";
          } else if (requesting === card.kind) {
            actionLabel = "Opening\u2026";
          }

          const detailParts = [
            card.requiresRelaunch
              ? "You may need to reopen Stella after enabling it"
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

      <button
        className="onboarding-confirm"
        data-visible={true}
        disabled={splitTransitionActive}
        onClick={onContinue}
      >
        {allMeasuredGranted ? "Continue" : "Skip for now"}
      </button>
    </div>
  );
}
