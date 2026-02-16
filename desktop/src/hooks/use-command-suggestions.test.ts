import { describe, expect, it } from "vitest";
import {
  type CommandSuggestion,
  useCommandSuggestions,
} from "./use-command-suggestions";
import type { EventRecord } from "./use-conversation-events";

const createEvent = (overrides: Partial<EventRecord> & { type: string }): EventRecord => ({
  _id: `event-${Math.random().toString(36).slice(2)}`,
  timestamp: Date.now(),
  ...overrides,
});

const suggestions: CommandSuggestion[] = [
  { commandId: "a", name: "Search", description: "Find items" },
  { commandId: "b", name: "Summarize", description: "Summarize notes" },
  { commandId: "c", name: "Draft", description: "Draft response" },
  { commandId: "d", name: "Create", description: "Create task" },
];

describe("useCommandSuggestions", () => {
  it("returns empty while streaming", () => {
    const events: EventRecord[] = [
      createEvent({
        type: "command_suggestions",
        payload: { suggestions },
      }),
    ];

    expect(useCommandSuggestions(events, true)).toEqual([]);
  });

  it("returns latest valid suggestions up to 3 items", () => {
    const events: EventRecord[] = [
      createEvent({
        type: "command_suggestions",
        payload: {
          suggestions: [{ commandId: 123, name: "bad" }, ...suggestions] as unknown,
        },
      }),
    ];

    expect(useCommandSuggestions(events, false)).toEqual(suggestions.slice(0, 3));
  });

  it("returns empty when suggestions are stale after a new message", () => {
    const events: EventRecord[] = [
      createEvent({
        type: "command_suggestions",
        payload: { suggestions },
      }),
      createEvent({ type: "assistant_message", payload: { text: "done" } }),
    ];

    expect(useCommandSuggestions(events, false)).toEqual([]);
  });

  it("returns empty for missing or invalid suggestion payload", () => {
    const missingPayload = [createEvent({ type: "command_suggestions" })];
    const invalidPayload = [
      createEvent({ type: "command_suggestions", payload: { suggestions: "oops" } }),
    ];

    expect(useCommandSuggestions(missingPayload, false)).toEqual([]);
    expect(useCommandSuggestions(invalidPayload, false)).toEqual([]);
  });
});
