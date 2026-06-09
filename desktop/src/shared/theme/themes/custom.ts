import type { Theme } from "./types";
import light from "./light";

// The "Custom" overlay theme. Every user is on this by default. While it is
// empty (`populated: false`) it is an invisible passthrough to its `base`
// theme and stays hidden from the theme picker, so a fresh install looks
// exactly like the base.
//
// This is where redesigns and personal look tweaks belong: because the user is
// already on Custom, changes written here show up immediately (with the
// self-mod morph reflecting a real diff) instead of being stranded in a theme
// nobody selected. Switching to any stock theme leaves Custom intact, and
// selecting Custom again restores the personalized look.
//
// How agents/users write into it:
//   - Colors: add entries to `overrides.light` / `overrides.dark`.
//   - Structure / typography / backgrounds: target `:root[data-theme="custom"]`
//     in CSS (the base theme's tuning still applies via `data-base-theme`).
//   - Flip `populated` to `true` so Custom appears in the picker.
const custom: Theme = {
  id: "custom",
  name: "Custom",
  base: "light",
  overrides: { light: {}, dark: {} },
  populated: false,
  // Fallback colors if the base lookup ever fails; resolution normally derives
  // colors from `base` + `overrides`.
  light: light.light,
  dark: light.dark,
};

export default custom;
