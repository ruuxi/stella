/**
 * Voice phase — two looping demos instead of static cards.
 *
 * Left: the wake-word conversation beat ("Hey Stella" → listening →
 * reply → "Bye") plays on a gentle loop around the pet sprite.
 * Right: dictation actually happens — the key is held, the recording
 * pill pops over a mail draft, and the sentence types itself into the
 * body before the pill confirms away. Both run on the shared
 * choreography engine with reserved slots so nothing ever shifts.
 */

import { useEffect, useRef, type CSSProperties } from "react";
import { Check, X } from "@/ui/icons";
import { getPlatform } from "@/platform/electron/platform";
import { DEFAULT_PET_ID } from "@/shell/pet/built-in-pets";
import { useSelectedPet } from "@/shell/pet/pet-catalog-context";
import { useSelectedPetId } from "@/shell/pet/pet-preferences";
import { PetSprite } from "@/shell/pet/PetSprite";
import { Keychord } from "./Keychord";
import {
  useChoreography,
  useTypedText,
  type ChoreographyCue,
} from "./demo/use-choreography";
import "./OnboardingVoicePhase.css";

type VoicePhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

type KeyLabel = { glyphs: string[]; aria: string; name: string };

// On macOS the default dictation shortcut is push-to-talk: hold the Option
// key. Other platforms keep the Ctrl+M toggle.
const DICTATE_KEY_BY_PLATFORM: Record<string, KeyLabel> = {
  darwin: { glyphs: ["⌥"], aria: "Hold Option", name: "Option" },
  win32: { glyphs: ["Ctrl", "M"], aria: "Control M", name: "Ctrl M" },
  linux: { glyphs: ["Ctrl", "M"], aria: "Control M", name: "Ctrl M" },
};

const DICTATED_SENTENCE =
  "Hey Alex, pushing the launch to next Tuesday so we have time to polish the deck.";
const TYPE_CHAR_MS = 26;
const TYPE_START_AT = 1600;

const DICTATE_CUES: ChoreographyCue[] = [
  { id: "press", at: 600 },
  { id: "pill", at: 1050 },
  { id: "type", at: TYPE_START_AT },
  {
    id: "confirmed",
    at: TYPE_START_AT + DICTATED_SENTENCE.length * TYPE_CHAR_MS + 600,
  },
  {
    id: "end",
    at: TYPE_START_AT + DICTATED_SENTENCE.length * TYPE_CHAR_MS + 2400,
  },
];

const TALK_CUES: ChoreographyCue[] = [
  { id: "hey", at: 600 },
  { id: "listen", at: 1300 },
  { id: "reply", at: 2500 },
  { id: "bye", at: 4900 },
  { id: "end", at: 6200 },
];

const LOOP_HOLD_MS = 1900;

/**
 * Choreography that replays itself after a short hold. Reduced motion
 * skips the restart loop — the hook already fast-forwards to the final
 * state, which is the right static rendering of each card.
 */
function useLoopingChoreography(cues: readonly ChoreographyCue[]) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { has, restart } = useChoreography({
    cues,
    active: true,
    onDone: () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      timerRef.current = setTimeout(restart, LOOP_HOLD_MS);
    },
  });

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return has;
}

export function OnboardingVoicePhase({
  splitTransitionActive,
  onContinue,
}: VoicePhaseProps) {
  const platform = getPlatform();
  const dictateKey =
    DICTATE_KEY_BY_PLATFORM[platform] ?? DICTATE_KEY_BY_PLATFORM.darwin;
  const [selectedPetId] = useSelectedPetId(DEFAULT_PET_ID);
  const pet = useSelectedPet(selectedPetId);

  const talk = useLoopingChoreography(TALK_CUES);
  const dictate = useLoopingChoreography(DICTATE_CUES);

  const typed = useTypedText(DICTATED_SENTENCE, dictate("type"), {
    charMs: TYPE_CHAR_MS,
  });

  const listening = talk("listen") && !talk("bye");
  const keyHeld = dictate("press") && !dictate("confirmed");
  const pillVisible = dictate("pill") && !dictate("confirmed");

  return (
    <div className="onboarding-step-content ovoice-step">
      <div className="ovoice-grid">
        <section className="ovoice-card">
          <span className="ovoice-card__label">Voice</span>
          <p className="ovoice-card__instruction">
            Say "Hey Stella" to start a conversation. Say "Bye" to end it.
          </p>

          <div className="ovoice-card__surface" aria-hidden="true">
            <div className="ovoice-talk">
              <div
                className="ovoice-talk__quote"
                data-visible={(talk("hey") && !talk("bye")) || undefined}
              >
                "Hey Stella"
              </div>

              <div
                className="ovoice-talk__sprite"
                data-listening={listening || undefined}
              >
                <span className="ovoice-talk__ring" />
                <span className="ovoice-talk__ring" data-late="" />
                {pet ? (
                  <PetSprite
                    spritesheetUrl={pet.spritesheetUrl}
                    state="waving"
                    continuous
                    size={128}
                  />
                ) : null}
              </div>

              <div className="ovoice-talk__exchange">
                <span
                  className="ovoice-talk__reply"
                  data-visible={(talk("reply") && !talk("bye")) || undefined}
                >
                  Hi. What should we get done?
                </span>
                <span
                  className="ovoice-talk__quote ovoice-talk__quote--bye"
                  data-visible={talk("bye") || undefined}
                >
                  "Bye"
                </span>
              </div>
            </div>
          </div>

          <p className="ovoice-card__footnote">
            Off by default. Turn on in Settings → Audio.
          </p>
        </section>

        <section className="ovoice-card">
          <span className="ovoice-card__label">Dictation</span>
          <p className="ovoice-card__instruction">
            Hold {dictateKey.name} and talk. The words land wherever your cursor
            is.
          </p>

          <div className="ovoice-card__surface" aria-hidden="true">
            <div className="ovoice-dictate">
              <div
                className="ovoice-dictate__chord"
                data-held={keyHeld || undefined}
              >
                <Keychord
                  aria={dictateKey.aria}
                  glyphs={dictateKey.glyphs}
                  size="compact"
                  highlight={keyHeld}
                />
                <span className="ovoice-dictate__chord-hint">hold</span>
              </div>

              <div className="ovoice-app">
                <div className="ovoice-app__bar">
                  <span />
                  <span />
                  <span />
                  <strong>Mail — New message</strong>
                </div>
                <div className="ovoice-app__body">
                  <div className="ovoice-app__field">
                    <span className="ovoice-app__field-label">To</span>
                    <span className="ovoice-app__field-value">
                      alex@team.com
                    </span>
                  </div>
                  <div className="ovoice-app__field">
                    <span className="ovoice-app__field-label">Subject</span>
                    <span className="ovoice-app__field-value">
                      Quick update
                    </span>
                  </div>
                  <div className="ovoice-app__editor">
                    {typed.value}
                    <span className="ovoice-app__caret" />
                  </div>
                </div>

                {/* Faithful mock of the real `.dictation-overlay` pill. */}
                <div
                  className="ovoice-pill"
                  data-visible={pillVisible || undefined}
                >
                  <FakeWaveform active={pillVisible} />
                  <span className="ovoice-pill__timer">0:04</span>
                  <span className="ovoice-pill__btn">
                    <X size={13} />
                  </span>
                  <span className="ovoice-pill__btn ovoice-pill__btn--confirm">
                    <Check size={14} />
                  </span>
                </div>
              </div>
            </div>
          </div>

          <p className="ovoice-card__footnote">
            Works in any app: email, Notes, the browser.
          </p>
        </section>
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

/* Animated waveform replica matching the right-aligned scrolling bars
 * the real DictationRecordingBar renders to canvas — DOM bars with
 * phase-shifted CSS animations so the demo needs no audio session. */
const WAVEFORM_BAR_COUNT = 22;
const WAVEFORM_BARS = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, i) => {
  const seed = (i * 37) % 100;
  return {
    key: i,
    style: {
      animationDelay: `${(seed % 100) * 12}ms`,
      "--bar-peak": `${30 + ((seed * 7) % 70)}%`,
    } as CSSProperties,
  };
});

function FakeWaveform({ active }: { active: boolean }) {
  return (
    <div className="ovoice-waveform" data-active={active || undefined}>
      {WAVEFORM_BARS.map((bar) => (
        <span
          key={bar.key}
          className="ovoice-waveform__bar"
          style={bar.style}
        />
      ))}
    </div>
  );
}
