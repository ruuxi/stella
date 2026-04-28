import { useCallback, useMemo, useState, type CSSProperties } from "react";
import "./OnboardingMemoryPhase.css";

type MemoryPhaseProps = {
  splitTransitionActive: boolean;
  isAuthenticated: boolean;
  /** Called when the user advances. The handler decides whether to also
   *  request post-onboarding sign-in (when memory is on but unauth). */
  onContinue: (args: {
    memoryEnabled: boolean;
    requestSignIn: boolean;
  }) => void;
};

/**
 * Onboarding "Live Memory" phase.
 *
 * Shows two side-by-side mocks of a Stella conversation surface — left
 * pane with Live Memory off (Stella has to ask for clarification), right
 * pane with Live Memory on (Stella already knows the context). A single
 * toggle below opts into Live Memory.
 *
 * If the user opts in but isn't signed in, we surface an inline notice
 * and tell `onContinue` to request a sign-in prompt after onboarding
 * completes. Live Memory itself stays dormant until the user signs in
 * (see `memory:promotePending` in the IPC).
 */
export function OnboardingMemoryPhase({
  splitTransitionActive,
  isAuthenticated,
  onContinue,
}: MemoryPhaseProps) {
  const [memoryEnabled, setMemoryEnabled] = useState(false);

  // Per-mock typing animation: we stagger the assistant reply so it feels
  // like the conversation is live. Bumping this key re-mounts both mocks
  // so users can replay the comparison after each toggle.
  const [animationKey, setAnimationKey] = useState(0);

  const handleToggle = useCallback(() => {
    setMemoryEnabled((current) => !current);
    setAnimationKey((current) => current + 1);
  }, []);

  const handleContinue = useCallback(() => {
    onContinue({
      memoryEnabled,
      requestSignIn: memoryEnabled && !isAuthenticated,
    });
  }, [isAuthenticated, memoryEnabled, onContinue]);

  const showSignInNotice = memoryEnabled && !isAuthenticated;

  return (
    <div className="onboarding-step-content onboarding-memory-step">
      <p className="onboarding-step-desc onboarding-memory-step__lede">
        Stella can quietly remember what you've been working on so you don't
        have to repeat yourself. Off by default — turn it on whenever you want.
      </p>

      <div className="onboarding-memory-grid" key={animationKey}>
        <MemoryComparisonMock
          variant="off"
          label="Without Live Memory"
          subLabel="Stella has to ask"
        />
        <MemoryComparisonMock
          variant="on"
          label="With Live Memory"
          subLabel="Stella already knows"
        />
      </div>

      <div className="onboarding-memory-controls">
        <button
          type="button"
          className="onboarding-memory-toggle"
          role="switch"
          aria-checked={memoryEnabled}
          onClick={handleToggle}
        >
          <span className="onboarding-memory-toggle__track" aria-hidden="true">
            <span className="onboarding-memory-toggle__thumb" />
          </span>
          <span className="onboarding-memory-toggle__label">
            {memoryEnabled ? "Live Memory on" : "Enable Live Memory"}
          </span>
        </button>

        <p className="onboarding-step-subdesc onboarding-memory-controls__hint">
          {memoryEnabled
            ? "Stella will reference your screen context when helpful. You can pause or turn this off any time from Settings."
            : "Skip for now — you can always turn this on later in Settings."}
        </p>

        <div
          className="onboarding-memory-signin-notice"
          data-visible={showSignInNotice || undefined}
          aria-hidden={!showSignInNotice}
        >
          You'll need to sign in for Live Memory to start. We'll prompt you
          right after onboarding.
        </div>
      </div>

      <button
        className="onboarding-confirm"
        data-visible={true}
        disabled={splitTransitionActive}
        onClick={handleContinue}
      >
        Continue
      </button>
    </div>
  );
}

type ComparisonVariant = "off" | "on";

type ChatLine =
  | { from: "user"; text: string; delayMs: number }
  | {
      from: "assistant";
      text: string;
      delayMs: number;
      typingMs?: number;
    };

const VAGUE_USER_PROMPT = "Can you summarize this for me?";

const SCRIPTS: Record<ComparisonVariant, ChatLine[]> = {
  off: [
    { from: "user", text: VAGUE_USER_PROMPT, delayMs: 240 },
    {
      from: "assistant",
      text: "Sure — which document or page are you looking at? Drop it in or paste a link and I'll summarize it.",
      delayMs: 1100,
      typingMs: 720,
    },
    {
      from: "user",
      text: "The Q2 product brief in Notion…",
      delayMs: 2400,
    },
  ],
  on: [
    { from: "user", text: VAGUE_USER_PROMPT, delayMs: 240 },
    {
      from: "assistant",
      text: "On it — the Q2 product brief in Notion. Top: revenue +23% YoY, mid-market traction up 14% QoQ, three risks called out. Want the highlights or the full breakdown?",
      delayMs: 1100,
      typingMs: 900,
    },
  ],
};

function MemoryComparisonMock({
  variant,
  label,
  subLabel,
}: {
  variant: ComparisonVariant;
  label: string;
  subLabel: string;
}) {
  const script = SCRIPTS[variant];

  // Compute the cumulative reveal timestamps from the script so we can
  // fire a single `data-revealed` flag per line via inline animation
  // delays. Memo-cached so re-renders don't reshuffle timing.
  const lines = useMemo(
    () =>
      script.map((line, index) => ({
        ...line,
        index,
      })),
    [script],
  );

  return (
    <div className="onboarding-memory-mock" data-variant={variant}>
      <div className="onboarding-memory-mock__chrome">
        <span className="onboarding-memory-mock__dot" data-color="r" />
        <span className="onboarding-memory-mock__dot" data-color="y" />
        <span className="onboarding-memory-mock__dot" data-color="g" />
        <span className="onboarding-memory-mock__title">
          <span className="onboarding-memory-mock__title-label">{label}</span>
          {variant === "on" ? (
            <span className="onboarding-memory-mock__pill">
              <span
                className="onboarding-memory-mock__pill-dot"
                aria-hidden="true"
              />
              Live Memory
            </span>
          ) : (
            <span className="onboarding-memory-mock__pill onboarding-memory-mock__pill--muted">
              Memory off
            </span>
          )}
        </span>
      </div>

      <div className="onboarding-memory-mock__body">
        <aside className="onboarding-memory-mock__rail" aria-hidden="true">
          <div className="onboarding-memory-mock__rail-brand">
            <span className="onboarding-memory-mock__rail-glyph" />
            <span className="onboarding-memory-mock__rail-name">Stella</span>
          </div>
          <div className="onboarding-memory-mock__rail-item">Home</div>
          <div className="onboarding-memory-mock__rail-item is-active">
            Chat
          </div>
          <div className="onboarding-memory-mock__rail-item">Memory</div>
          <div className="onboarding-memory-mock__rail-spacer" />
          <div className="onboarding-memory-mock__rail-item">Settings</div>
        </aside>

        <div className="onboarding-memory-mock__chat">
          <div className="onboarding-memory-mock__chat-scroll">
            {lines.map((line) => (
              <div
                key={`${variant}-${line.index}`}
                className="onboarding-memory-mock__line"
                data-from={line.from}
                style={{
                  animationDelay: `${line.delayMs}ms`,
                }}
              >
                {line.from === "assistant" && line.typingMs ? (
                  <span
                    className="onboarding-memory-mock__typing"
                    style={
                      {
                        animationDelay: `${line.delayMs}ms`,
                        animationDuration: `${line.typingMs}ms`,
                        "--typing-dot-count": Math.ceil(line.typingMs / 1000),
                      } as CSSProperties
                    }
                    aria-hidden="true"
                  >
                    <span />
                    <span />
                    <span />
                  </span>
                ) : null}
                <span
                  className="onboarding-memory-mock__bubble"
                  style={
                    line.from === "assistant" && line.typingMs
                      ? {
                          animationDelay: `${line.delayMs + line.typingMs}ms`,
                        }
                      : { animationDelay: `${line.delayMs}ms` }
                  }
                >
                  {line.text}
                </span>
              </div>
            ))}
          </div>

          <div className="onboarding-memory-mock__composer" aria-hidden="true">
            <span className="onboarding-memory-mock__composer-placeholder">
              Ask Stella anything…
            </span>
          </div>
        </div>
      </div>

      <div className="onboarding-memory-mock__caption">{subLabel}</div>
    </div>
  );
}
