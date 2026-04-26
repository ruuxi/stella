/**
 * Shared types for the StellaAppMock landing-page demo.
 * Mirrors `desktop/src/global/onboarding/panels/stella-app-mock-types.ts`.
 */

export type SectionKey =
  | "sidebar"
  | "header"
  | "messages"
  | "composer"
  | "createApp";

export type SectionToggles = Record<SectionKey, boolean>;

export const EMPTY_SECTION_TOGGLES: SectionToggles = {
  sidebar: false,
  header: false,
  messages: false,
  composer: false,
  createApp: false,
};
