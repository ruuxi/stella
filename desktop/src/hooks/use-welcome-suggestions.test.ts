import { describe, expect, it } from "vitest";
import type { WelcomeSuggestion } from "../services/synthesis";
import type { EventRecord } from "./use-conversation-events";
import { useWelcomeSuggestions } from "./use-welcome-suggestions";

const createEvent = (overrides: Partial<EventRecord> & { type: string }): EventRecord => ({
  _id: `event-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  ...overrides,
});

const suggestions: WelcomeSuggestion[] = [
  { category: "skill", title: "Skill 1", description: "desc", prompt: "p1" },
  { category: "app", title: "App 2", description: "desc", prompt: "p2" },
  { category: "cron", title: "Cron 3", description: "desc", prompt: "p3" },
  { category: "skill", title: "Skill 4", description: "desc", prompt: "p4" },
  { category: "app", title: "App 5", description: "desc", prompt: "p5" },
  { category: "cron", title: "Cron 6", description: "desc", prompt: "p6" },
];

describe("useWelcomeSuggestions", () => {
  it("returns latest suggestions trimmed to 5", () => {
    const events: EventRecord[] = [
      createEvent({
        type: "welcome_suggestions",
        payload: { suggestions },
      }),
    ];

    expect(useWelcomeSuggestions(events)).toEqual(suggestions.slice(0, 5));
  });

  it("returns empty when a user message appears after suggestions", () => {
    const events: EventRecord[] = [
      createEvent({
        type: "welcome_suggestions",
        payload: { suggestions },
      }),
      createEvent({ type: "user_message", payload: { text: "hi" } }),
    ];

    expect(useWelcomeSuggestions(events)).toEqual([]);
  });

  it("returns empty for missing/invalid suggestion payload", () => {
    const missingPayload = [createEvent({ type: "welcome_suggestions" })];
    const invalidPayload = [
      createEvent({ type: "welcome_suggestions", payload: { suggestions: "oops" } }),
    ];

    expect(useWelcomeSuggestions(missingPayload)).toEqual([]);
    expect(useWelcomeSuggestions(invalidPayload)).toEqual([]);
  });

  it("returns empty when no welcome_suggestions event exists", () => {
    const events: EventRecord[] = [createEvent({ type: "assistant_message", payload: { text: "hello" } })];
    expect(useWelcomeSuggestions(events)).toEqual([]);
  });
});
