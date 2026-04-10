import { useCallback, useEffect, useRef, useState } from "react";

type PermissionKind = "accessibility" | "screen" | "microphone";

type PermissionStatus = Record<PermissionKind, boolean>;

const PERMISSION_CARDS: {
  kind: PermissionKind;
  title: string;
  description: string;
}[] = [
  {
    kind: "accessibility",
    title: "Accessibility",
    description:
      "Enables the radial menu, reading selected text, and understanding what\u2019s on screen.",
  },
  {
    kind: "screen",
    title: "Screen Recording",
    description:
      "Lets Stella capture screenshots and see window content when you ask.",
  },
  {
    kind: "microphone",
    title: "Microphone",
    description:
      "Powers voice conversations and wake-word detection.",
  },
];

const POLL_INTERVAL_MS = 1500;

type OnboardingPermissionsProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
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

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    const result = await window.electronAPI?.system.getPermissionStatus?.();
    if (result) {
      setStatus(result);
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

  const handleEnable = useCallback(async (kind: PermissionKind) => {
    setRequesting(kind);
    try {
      const result =
        await window.electronAPI?.system.requestPermission?.(kind);
      if (result?.granted) {
        setStatus((prev) => ({ ...prev, [kind]: true }));
        return;
      }
      window.electronAPI?.system.openPermissionSettings?.(kind);
    } catch {
      window.electronAPI?.system.openPermissionSettings?.(kind);
    } finally {
      setRequesting(null);
    }
  }, []);

  const allGranted = status.accessibility && status.screen && status.microphone;

  return (
    <div className="onboarding-step-content">
      <div className="onboarding-step-label">Permissions</div>
      <p className="onboarding-step-desc">
        Stella needs a few macOS permissions to work at its best.
        Enable each one below — you can always change these later in System Settings.
      </p>

      <div className="onboarding-permissions-list">
        {PERMISSION_CARDS.map((card) => {
          const granted = status[card.kind];
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
              </div>
              <button
                className="onboarding-permission-card__action"
                onClick={() => void handleEnable(card.kind)}
                disabled={granted || requesting === card.kind}
              >
                {granted
                  ? "Granted \u2713"
                  : requesting === card.kind
                    ? "Requesting\u2026"
                    : "Enable"}
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
        {allGranted ? "Continue" : "Skip for now"}
      </button>
    </div>
  );
}
