import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { getPlatform } from "@/platform/electron/platform";
import { Switch } from "@/ui/switch";
import { DEFAULT_PET_ID } from "@/shell/pet/built-in-pets";
import { useSelectedPet } from "@/shell/pet/pet-catalog-context";
import { useSelectedPetId } from "@/shell/pet/pet-preferences";
import { PetSprite } from "@/shell/pet/PetSprite";
import { Keychord } from "./Keychord";
import "./OnboardingVoicePhase.css";

type VoicePhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

type KeyLabel = { glyphs: string[]; aria: string };

// On macOS the default dictation shortcut is push-to-talk: hold the Option
// key. Other platforms keep the Ctrl+M toggle.
const DICTATE_KEY_BY_PLATFORM: Record<string, KeyLabel> = {
  darwin: { glyphs: ["⌥"], aria: "Hold Option" },
  win32: { glyphs: ["Ctrl", "M"], aria: "Control M" },
  linux: { glyphs: ["Ctrl", "M"], aria: "Control M" },
};

/**
 * Onboarding "voice" phase.
 *
 * Two side-by-side cards:
 *   - "Hey Stella" wake-word card with a toggle. The voice agent is
 *     wake-word gated — there is no keybind for it.
 *   - Dictation card mirroring the live `dictation-overlay` floating
 *     above a generic "any app" surface.
 */
export function OnboardingVoicePhase({
  splitTransitionActive,
  onContinue,
}: VoicePhaseProps) {
  const platform = getPlatform();
  const dictateKey =
    DICTATE_KEY_BY_PLATFORM[platform] ?? DICTATE_KEY_BY_PLATFORM.darwin;
  const [selectedPetId] = useSelectedPetId(DEFAULT_PET_ID);
  const pet = useSelectedPet(selectedPetId);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.system
      ?.getWakeWordEnabled?.()
      .then((enabled) => {
        if (!cancelled) setWakeWordEnabled(enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleWakeWordToggle = useCallback((checked: boolean) => {
    setWakeWordEnabled(checked);
    void window.electronAPI?.system
      ?.setWakeWordEnabled?.(checked)
      .catch(() => {
        setWakeWordEnabled(!checked);
      });
  }, []);

  return (
    <div className="onboarding-step-content onboarding-voice-step">
      <p className="onboarding-step-desc onboarding-voice-step__lede">
        Say "Hey Stella" anywhere to start a voice conversation. Hold the
        dictation key to type with your voice in any app.
      </p>

      <div className="onboarding-voice-grid">
        <article className="onboarding-voice-card" data-variant="talk">
          <div className="onboarding-voice-card__body">
            <header className="onboarding-voice-card__header">
              <div className="onboarding-voice-card__heading">
                <span className="onboarding-voice-card__eyebrow">
                  Speak with Stella
                </span>
                <h3 className="onboarding-voice-card__title">
                  Say "Hey Stella" to start, "Bye" to end.
                </h3>
              </div>
              <div className="onboarding-voice-card__toggle">
                <Switch
                  checked={wakeWordEnabled}
                  onCheckedChange={handleWakeWordToggle}
                  hideLabel
                  aria-label="Enable Hey Stella wake word"
                />
              </div>
            </header>

            <div className="onboarding-voice-card__stage onboarding-voice-card__stage--talk">
              <div className="onboarding-voice-wave-sprite" aria-hidden="true">
                {pet ? (
                  <PetSprite
                    spritesheetUrl={pet.spritesheetUrl}
                    state="waving"
                    continuous
                    size={120}
                  />
                ) : null}
              </div>
            </div>

            <p className="onboarding-voice-card__caption">
              {wakeWordEnabled
                ? 'Stella listens for "Hey Stella" in the background. No keybind needed.'
                : "Wake word off — turn it on to start voice with your voice."}
            </p>
          </div>
        </article>

        <article className="onboarding-voice-card" data-variant="dictate">
          <Keychord aria={dictateKey.aria} glyphs={dictateKey.glyphs} />
          <div className="onboarding-voice-card__body">
            <header className="onboarding-voice-card__header">
              <div className="onboarding-voice-card__heading">
                <span className="onboarding-voice-card__eyebrow">
                  Dictate anywhere
                </span>
                <h3 className="onboarding-voice-card__title">
                  Speak. Stella types.
                </h3>
              </div>
            </header>

            <div className="onboarding-voice-card__stage onboarding-voice-card__stage--dictate">
              {/* "Any app" surface — generic email draft to make it
                  clear this overlay floats above whatever the user is
                  in, not just Stella. */}
              <div className="onboarding-voice-app" aria-hidden="true">
                <div className="onboarding-voice-app__bar">
                  <span />
                  <span />
                  <span />
                  <strong>Mail — New message</strong>
                </div>
                <div className="onboarding-voice-app__body">
                  <div className="onboarding-voice-app__field">
                    <span className="onboarding-voice-app__label">To</span>
                    <span className="onboarding-voice-app__value">
                      alex@team.com
                    </span>
                  </div>
                  <div className="onboarding-voice-app__field">
                    <span className="onboarding-voice-app__label">Subject</span>
                    <span className="onboarding-voice-app__value">
                      Quick update
                    </span>
                  </div>
                  <div className="onboarding-voice-app__editor">
                    <span className="onboarding-voice-app__typed">
                      Hey Alex — pushing the launch to next Tuesday so we have
                      time to polish the deck.
                    </span>
                    <span className="onboarding-voice-app__caret" />
                  </div>
                </div>
              </div>

              {/* Faithful mock of `.dictation-overlay` +
                  DictationRecordingBar. Static visual replica — no
                  live audio in onboarding. */}
              <div
                className="onboarding-voice-dictation-overlay"
                aria-hidden="true"
              >
                <FakeWaveform />
                <span className="onboarding-voice-dictation-timer">0:04</span>
                <button
                  type="button"
                  className="onboarding-voice-dictation-btn onboarding-voice-dictation-btn--cancel"
                  tabIndex={-1}
                  aria-label="Cancel dictation"
                >
                  <CancelIcon />
                </button>
                <button
                  type="button"
                  className="onboarding-voice-dictation-btn onboarding-voice-dictation-btn--confirm"
                  tabIndex={-1}
                  aria-label="Stop dictation and transcribe"
                >
                  <CheckIcon />
                </button>
              </div>
            </div>

            <p className="onboarding-voice-card__caption">
              Works in any app — email, Notes, browser, anywhere your cursor is.
            </p>
          </div>
        </article>
      </div>

      <button
        className="onboarding-confirm"
        data-visible={true}
        disabled={splitTransitionActive}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}

/* Animated waveform replica that visually matches the right-aligned
 * scrolling bars rendered to canvas in `DictationRecordingBar`. We use
 * lightweight DOM bars with phase-shifted CSS animations so the demo
 * doesn't need an audio capture session. */
const WAVEFORM_BAR_COUNT = 24;
const WAVEFORM_BARS = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, i) => {
  const seed = (i * 37) % 100;
  return {
    key: i,
    style: {
      animationDelay: `${(seed % 100) * 12}ms`,
      // Slightly lower amplitude for the leading (older) bars so the
      // right-most "now" bars feel most active — same shape the real canvas
      // renders.
      "--bar-peak": `${30 + ((seed * 7) % 70)}%`,
    } as CSSProperties,
  };
});

function FakeWaveform() {
  return (
    <div className="onboarding-voice-waveform" aria-hidden="true">
      {WAVEFORM_BARS.map((bar) => (
        <span
          key={bar.key}
          className="onboarding-voice-waveform__bar"
          style={bar.style}
        />
      ))}
    </div>
  );
}

function CancelIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="6" y1="18" x2="18" y2="6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="5 12 10 17 19 7" />
    </svg>
  );
}
