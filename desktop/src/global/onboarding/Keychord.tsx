import "./Keychord.css";

type KeychordProps = {
  glyphs: string[];
  aria: string;
  size?: "default" | "compact";
  highlight?: boolean;
};

/**
 * Shared keychord visual used across onboarding phases (voice, double-tap,
 * radial). The look is the raised-Mac-key style introduced in the voice
 * phase: large keycaps with a slightly thicker bottom border and a small
 * `+` separator between groups. Standardizing on this shape so the user
 * sees the same chord visual everywhere a shortcut is taught.
 *
 * `size="compact"` shrinks the cap dimensions for inline use inside dense
 * onboarding cards (e.g. the dial prompt), while preserving the same
 * visual vocabulary.
 */
export function Keychord({
  glyphs,
  aria,
  size = "default",
  highlight,
}: KeychordProps) {
  return (
    <div
      className="onboarding-keychord"
      data-size={size}
      data-highlight={highlight || undefined}
      role="img"
      aria-label={aria}
    >
      {glyphs.map((glyph, i) => (
        <span key={i} className="onboarding-keychord__group">
          {i > 0 ? (
            <span className="onboarding-keychord__sep" aria-hidden="true">
              +
            </span>
          ) : null}
          <span className="onboarding-keychord__cap">{glyph}</span>
        </span>
      ))}
    </div>
  );
}
