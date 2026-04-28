import { Mic, Sparkles } from "lucide-react";
import { getPlatform } from "@/platform/electron/platform";
import "./OnboardingVoicePhase.css";

type VoicePhaseProps = {
  splitTransitionActive: boolean;
  onContinue: () => void;
};

type KeyLabel = { glyphs: string[]; aria: string };

const TALK_KEY_BY_PLATFORM: Record<string, KeyLabel> = {
  darwin: { glyphs: ["⌘", "⇧", "D"], aria: "Command Shift D" },
  win32: { glyphs: ["Ctrl", "Shift", "D"], aria: "Control Shift D" },
  linux: { glyphs: ["Ctrl", "Shift", "D"], aria: "Control Shift D" },
};

const DICTATE_KEY_BY_PLATFORM: Record<string, KeyLabel> = {
  darwin: { glyphs: ["⌃", "M"], aria: "Control M" },
  win32: { glyphs: ["Ctrl", "M"], aria: "Control M" },
  linux: { glyphs: ["Ctrl", "M"], aria: "Control M" },
};

/**
 * Onboarding "voice" phase.
 *
 * Teaches the two voice shortcuts that work from anywhere on the
 * computer:
 *   - ⌘⇧D: open a voice conversation with Stella (she listens and
 *     replies out loud)
 *   - ⌃M: dictation — speak and the words are typed wherever the
 *     cursor is, in *any* app, not just Stella
 *
 * The two are visually distinct (chat bubbles vs. text-being-typed
 * inside a generic app window) so the difference reads at a glance,
 * but the chrome / typography reuses the rest of the onboarding panel
 * language.
 */
export function OnboardingVoicePhase({
  splitTransitionActive,
  onContinue,
}: VoicePhaseProps) {
  const platform = getPlatform();
  const talkKey =
    TALK_KEY_BY_PLATFORM[platform] ?? TALK_KEY_BY_PLATFORM.darwin;
  const dictateKey =
    DICTATE_KEY_BY_PLATFORM[platform] ?? DICTATE_KEY_BY_PLATFORM.darwin;

  return (
    <div className="onboarding-step-content onboarding-voice-step">
      <p className="onboarding-step-desc onboarding-voice-step__lede">
        Two voice shortcuts that work anywhere on your computer — one to
        talk with Stella, one to type with your voice in any app.
      </p>

      <div className="onboarding-voice-grid">
        <article className="onboarding-voice-card" data-variant="talk">
          <header className="onboarding-voice-card__header">
            <div className="onboarding-voice-card__heading">
              <span className="onboarding-voice-card__eyebrow">
                Talk with Stella
              </span>
              <h3 className="onboarding-voice-card__title">
                Have a real conversation.
              </h3>
            </div>
            <Keychord aria={talkKey.aria} glyphs={talkKey.glyphs} />
          </header>

          <div className="onboarding-voice-card__stage">
            <div className="onboarding-voice-orb" aria-hidden="true">
              <span className="onboarding-voice-orb__ring" />
              <span className="onboarding-voice-orb__ring onboarding-voice-orb__ring--lg" />
              <span className="onboarding-voice-orb__core">
                <Sparkles size={16} />
              </span>
            </div>
            <div className="onboarding-voice-bubbles" aria-hidden="true">
              <div className="onboarding-voice-bubble onboarding-voice-bubble--user">
                What's on my plate today?
              </div>
              <div className="onboarding-voice-bubble onboarding-voice-bubble--assistant">
                Three meetings and the launch draft. Want me to read the
                first email out loud?
              </div>
            </div>
          </div>

          <p className="onboarding-voice-card__caption">
            Stella listens and replies out loud — like a phone call.
          </p>
        </article>

        <article className="onboarding-voice-card" data-variant="dictate">
          <header className="onboarding-voice-card__header">
            <div className="onboarding-voice-card__heading">
              <span className="onboarding-voice-card__eyebrow">
                Dictate anywhere
              </span>
              <h3 className="onboarding-voice-card__title">
                Speak. Stella types.
              </h3>
            </div>
            <Keychord aria={dictateKey.aria} glyphs={dictateKey.glyphs} />
          </header>

          <div className="onboarding-voice-card__stage">
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
            <div className="onboarding-voice-mic" aria-hidden="true">
              <span className="onboarding-voice-mic__pulse" />
              <Mic size={14} />
              <span className="onboarding-voice-mic__label">Listening…</span>
            </div>
          </div>

          <p className="onboarding-voice-card__caption">
            Works in any app — email, Notes, browser, anywhere your cursor
            is.
          </p>
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

function Keychord({ glyphs, aria }: { glyphs: string[]; aria: string }) {
  return (
    <div
      className="onboarding-voice-keychord"
      role="img"
      aria-label={aria}
    >
      {glyphs.map((glyph, i) => (
        <span key={i} className="onboarding-voice-keycap">
          {glyph}
        </span>
      ))}
    </div>
  );
}
