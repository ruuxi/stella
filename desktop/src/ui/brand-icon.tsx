/**
 * Provider brand glyphs for the model/provider pickers. Monochrome, sized
 * like the stroke icon set, tinted via `currentColor` so they follow text
 * color. Stella renders its own logo asset; providers without a known
 * brand glyph fall back to a neutral icon so new catalog providers never
 * render blank.
 */
import type { ReactElement } from "react";
import { AudioLines, Box, type IconProps } from "@/ui/icons";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import { BRAND_ICON_MARKUP } from "@/ui/brand-icon-paths";

/** Provider key → brand glyph key. Unlisted keys use the key itself. */
const BRAND_KEY_ALIASES: Record<string, string> = {
  "openai-codex": "openai",
  "google-gemini-cli": "gemini",
  "google-antigravity": "gemini",
  "kimi-coding": "kimi",
  "vercel-ai-gateway": "vercel",
  "github-copilot": "githubcopilot",
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
  const markup = BRAND_ICON_MARKUP[key];
  if (!markup) {
    const Fallback = FALLBACK_ICONS[key] ?? Box;
    return (
      <Fallback size={size} strokeWidth={1.75} className={className} aria-hidden />
    );
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      fillRule="evenodd"
      className={className}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
