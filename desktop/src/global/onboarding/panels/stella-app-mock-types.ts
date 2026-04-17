/**
 * Shared types and constants for the StellaAppMock onboarding demo.
 *
 * Kept in a separate module so `react-refresh/only-export-components` is
 * satisfied for `StellaAppMock.tsx`, which only exports the component itself.
 */

export type SectionKey = "sidebar" | "header" | "messages" | "composer";

export type SectionToggles = Record<SectionKey, boolean>;

export const EMPTY_SECTION_TOGGLES: SectionToggles = {
  sidebar: false,
  header: false,
  messages: false,
  composer: false,
};
