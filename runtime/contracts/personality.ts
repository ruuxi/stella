/** Personality preset metadata shared by the runtime and desktop renderer. */

export type PersonalityId = "stella" | "professional";

export const DEFAULT_PERSONALITY_ID: PersonalityId = "stella";

export type PersonalityOption = {
  id: PersonalityId;
  label: string;
  description: string;
};

export const PERSONALITY_OPTIONS: readonly PersonalityOption[] = [
  {
    id: "stella",
    label: "Stella",
    description: "Warm, sharp, and a little irreverent. Texts like a friend.",
  },
  {
    id: "professional",
    label: "Professional",
    description: "Calm, precise, and composed. Reads like a great assistant.",
  },
];

export const isKnownPersonalityId = (value: unknown): value is PersonalityId =>
  value === "stella" || value === "professional";

export const coercePersonalityId = (value: unknown): PersonalityId =>
  isKnownPersonalityId(value) ? value : DEFAULT_PERSONALITY_ID;
