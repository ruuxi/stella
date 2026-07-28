import { describe, expect, it } from "vitest";
import solstice from "@/shared/theme/themes/solarized";

const hexToRgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const mix = (foreground: string, background: string, amount: number): string => {
  const foregroundRgb = hexToRgb(foreground);
  const backgroundRgb = hexToRgb(background);
  const channels = foregroundRgb.map((channel, index) =>
    Math.round(
      channel * amount + backgroundRgb[index]! * (1 - amount),
    ),
  );
  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
};

const luminance = (hex: string): number =>
  hexToRgb(hex)
    .map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce(
      (total, channel, index) =>
        total + channel * [0.2126, 0.7152, 0.0722][index]!,
      0,
    );

const contrast = (foreground: string, background: string): number => {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
};

describe("Solstice dark theme contrast", () => {
  it("keeps normal and muted text readable on its dark surfaces", () => {
    const { background, backgroundWeak, foreground, mutedForeground } =
      solstice.dark;

    // Mirrors the dark-mode --text-base and --text-weak color-mix ramp.
    expect(contrast(mix(foreground, background, 0.82), background)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(mix(foreground, background, 0.6), background)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(mutedForeground, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(mutedForeground, backgroundWeak)).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});
