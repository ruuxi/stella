export type MiniDoubleTapModifier = "Alt" | "Control" | "Command" | "Shift" | "Off";

export const DEFAULT_MINI_DOUBLE_TAP_MODIFIER: MiniDoubleTapModifier = "Alt";

export const MINI_DOUBLE_TAP_MODIFIER_OPTIONS: MiniDoubleTapModifier[] = [
  "Alt",
  "Control",
  "Command",
  "Shift",
  "Off",
];

export const normalizeMiniDoubleTapModifier = (
  value: unknown,
): MiniDoubleTapModifier =>
  MINI_DOUBLE_TAP_MODIFIER_OPTIONS.includes(value as MiniDoubleTapModifier)
    ? (value as MiniDoubleTapModifier)
    : DEFAULT_MINI_DOUBLE_TAP_MODIFIER;

export const getMiniDoubleTapModifierLabel = (
  value: unknown,
  platform?: unknown,
): string => {
  const modifier = normalizeMiniDoubleTapModifier(value);
  if (modifier === "Off") return "Off";
  if (modifier === "Alt") return platform === "darwin" ? "Option" : "Alt";
  if (modifier === "Command") return platform === "darwin" ? "Command" : "Meta";
  return modifier;
};
