import { describe, expect, it } from "vitest";
import { assistantRowHasNonBackgroundContent } from "@/features/chat/hooks/use-event-rows";
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
