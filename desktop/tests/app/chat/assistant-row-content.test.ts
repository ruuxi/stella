import { describe, expect, it } from "vitest";
import { assistantRowHasNonBackgroundContent } from "@/features/chat/hooks/use-event-rows";
import {
  assistantRowHasVisibleContent,
  eventRowRendersContent,
} from "@/features/chat/lib/assistant-row-content";
import type { AssistantRowViewModel } from "@/features/chat/conversation-row-types";

const baseRow = (): AssistantRowViewModel => ({
  kind: "assistant",
  id: "row-1",
  text: "",
  cacheKey: "row-1",
});

/**
 * Guards the silent-drop failure mode: the background-card dedup pass drops a
 * row only when `assistantRowHasNonBackgroundContent` reports it carries
 * nothing else. If a content field is added to `AssistantRowViewModel` but
 * not mirrored into the predicate, a row holding only that content would be
 * silently removed. Each non-background content field must keep the row.
 */
describe("assistantRowHasNonBackgroundContent", () => {
  const contentFieldCases: Array<[string, Partial<AssistantRowViewModel>]> = [
    ["text", { text: "hello" }],
    ["isStreaming", { isStreaming: true }],
    ["officePreviewRef", { officePreviewRef: {} as never }],
    ["resourcePayload", { resourcePayload: {} as never }],
    ["inlineImagePayloads", { inlineImagePayloads: [{} as never] }],
    ["webSearchResults", { webSearchResults: [{} as never] }],
    ["sourceDiffPayloads", { sourceDiffPayloads: [{} as never] }],
    ["selfModApplied", { selfModApplied: {} as never }],
    ["scheduleReceipt", { scheduleReceipt: { affected: [] } }],
    ["voiceSession", { voiceSession: {} as never }],
    ["toolActivity", { toolActivity: {} as never }],
    ["customSlot", { customSlot: {} as never }],
  ];

  it.each(contentFieldCases)(
    "keeps a row that carries only %s",
    (_field, overrides) => {
      expect(
        assistantRowHasNonBackgroundContent({ ...baseRow(), ...overrides }),
      ).toBe(true);
    },
  );

  it("drops a row whose only content is a background-work receipt", () => {
    expect(
      assistantRowHasNonBackgroundContent({
        ...baseRow(),
        backgroundWork: {
          threadIds: ["t1"],
          descriptions: {},
          spawnedAtMs: {},
          completedThreadIds: [],
          supersededThreadIds: [],
        } as never,
      }),
    ).toBe(false);
  });

  it("drops an entirely empty row", () => {
    expect(assistantRowHasNonBackgroundContent(baseRow())).toBe(false);
  });
});

/**
 * Guards the invisible-spacer failure mode: `ChatTimeline` drops rows for
 * which `eventRowRendersContent` is false, and `AssistantMessageRow`
 * renders `null` for the same rows. If a content field is added to
 * `AssistantRowViewModel` but not mirrored into
 * `assistantRowHasVisibleContent`, a row holding only that content would
 * vanish from the timeline entirely.
 */
describe("assistantRowHasVisibleContent", () => {
  const visibleFieldCases: Array<[string, Partial<AssistantRowViewModel>]> = [
    ["text", { text: "hello" }],
    ["officePreviewRef", { officePreviewRef: {} as never }],
    ["resourcePayload", { resourcePayload: {} as never }],
    ["inlineImagePayloads", { inlineImagePayloads: [{} as never] }],
    ["webSearchResults", { webSearchResults: [{} as never] }],
    ["mapArtifacts", { mapArtifacts: [{} as never] }],
    ["sourceDiffPayloads", { sourceDiffPayloads: [{} as never] }],
    ["selfModApplied", { selfModApplied: {} as never }],
    ["customSlot", { customSlot: {} as never }],
    ["scheduleReceipt", { scheduleReceipt: { affected: [{} as never] } }],
    ["voiceSession", { voiceSession: {} as never }],
    [
      "backgroundWork",
      {
        backgroundWork: {
          threadIds: ["t1"],
          descriptions: {},
          spawnedAtMs: {},
          completedThreadIds: [],
          supersededThreadIds: [],
        } as never,
      },
    ],
    [
      "agentCompletion",
      { agentCompletion: { sections: [{} as never] } as never },
    ],
    ["toolActivity", { toolActivity: { steps: [{} as never] } as never }],
  ];

  it.each(visibleFieldCases)(
    "keeps a row that carries only %s",
    (_field, overrides) => {
      expect(
        assistantRowHasVisibleContent({ ...baseRow(), ...overrides }),
      ).toBe(true);
    },
  );

  it("reports an empty row as invisible", () => {
    expect(assistantRowHasVisibleContent(baseRow())).toBe(false);
  });

  it("treats empty collections as invisible (no phantom card rows)", () => {
    expect(
      assistantRowHasVisibleContent({
        ...baseRow(),
        scheduleReceipt: { affected: [] },
        toolActivity: { steps: [] } as never,
        agentCompletion: { sections: [] } as never,
        backgroundWork: {
          threadIds: [],
          descriptions: {},
          spawnedAtMs: {},
        } as never,
      }),
    ).toBe(false);
  });
});

describe("eventRowRendersContent", () => {
  it("always keeps user rows", () => {
    expect(
      eventRowRendersContent({
        kind: "user",
        id: "u1",
        text: "",
        attachments: [],
      }),
    ).toBe(true);
  });

  it("keeps an empty assistant row while it streams (scroll-follow target)", () => {
    expect(
      eventRowRendersContent({ ...baseRow(), isStreaming: true }),
    ).toBe(true);
  });

  it("drops a settled assistant row that paints nothing", () => {
    expect(eventRowRendersContent(baseRow())).toBe(false);
  });
});
