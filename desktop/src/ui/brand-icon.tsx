/**
 * Provider brand glyphs for the model/provider pickers. Brands with a
 * full-color logo render it directly; monochrome-brand glyphs are tinted
 * with the brand's canonical accent where one exists (so the rail reads as
 * recognizable logos, not a row of same-colored shapes) and otherwise
 * follow `currentColor`. Stella renders its own logo asset; providers
 * without a known glyph fall back to a neutral icon so new catalog
 * providers never render blank.
 */
import type { ReactElement } from "react";
import { AudioLines, Box, type IconProps } from "@/ui/icons";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import {
  BRAND_ICON_COLOR_MARKUP,
  BRAND_ICON_MARKUP,
} from "@/ui/brand-icon-paths";

/** Provider key → brand glyph key. Unlisted keys use the key itself. */
const BRAND_KEY_ALIASES: Record<string, string> = {
  "openai-codex": "openai",
  "google-gemini-cli": "gemini",
  "google-antigravity": "gemini",
  "kimi-coding": "kimi",
  "vercel-ai-gateway": "vercel",
  "github-copilot": "githubcopilot",
};

/**
 * Canonical accents for brands whose logos are monochrome. Brands whose
 * mark is genuinely black (xAI, Vercel, GitHub) stay on `currentColor`.
 */
const BRAND_TINTS: Record<string, string> = {
  openai: "#10a37f",
  anthropic: "#d97757",
  groq: "#f55036",
  openrouter: "#6467f2",
};

export interface BrandIconProps {
  /** Provider key (e.g. `openai`, `anthropic`, `stella`, `openrouter`). */
  brand: string;
  size?: number;
  className?: string;
}

const FALLBACK_ICONS: Record<string, (props: IconProps) => ReactElement> = {
  inworld: (props) => <AudioLines {...props} />,
};

export function BrandIcon({ brand, size = 16, className }: BrandIconProps) {
  if (brand === "stella") {
    return <StellaLogoIcon size={size} className={className} aria-hidden />;
  }
  const key = BRAND_KEY_ALIASES[brand] ?? brand;
  const colorMarkup = BRAND_ICON_COLOR_MARKUP[key];
  if (colorMarkup) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        // Paths without an explicit brand fill (e.g. Cerebras' letterform)
        // follow text color so they stay visible in dark mode.
        fill="currentColor"
        className={className}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: colorMarkup }}
      />
    );
  }
  const markup = BRAND_ICON_MARKUP[key];
  if (!markup) {
    const Fallback = FALLBACK_ICONS[key] ?? Box;
    return (
      <Fallback
        size={size}
        strokeWidth={1.75}
        className={className}
        aria-hidden
      />
    );
  }
  const tint = BRAND_TINTS[key];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      fillRule="evenodd"
      className={className}
      style={tint ? { color: tint } : undefined}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
