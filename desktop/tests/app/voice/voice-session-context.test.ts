import { describe, expect, it } from "vitest";

import { buildVoiceConversationHistoryBlock } from "@/features/voice/services/realtime/voice-session";

describe("voice realtime startup context", () => {
  it("formats prior conversation history for the realtime session", () => {
    const block = buildVoiceConversationHistoryBlock([
      {
        role: "user",
        content: "Can you create the HTML?",
        timestamp: Date.UTC(2026, 5, 5, 12),
      },
      {
        role: "assistant",
        content: "Yes, I created the summary page.",
        timestamp: Date.UTC(2026, 5, 5, 12, 1),
      },
      {
        role: "toolResult",
        content:
          "[Tool result] html\nCanvas saved to /Users/me/.stella/outputs/html/nvidia.html",
      },
    ]);

    expect(block).toContain("<conversation_history");
    expect(block).toContain("Treat them as already-known chat history");
    expect(block).toContain("[User @ 2026-06-05T12:00:00.000Z]");
    expect(block).toContain("  Can you create the HTML?");
    expect(block).toContain("[Stella @ 2026-06-05T12:01:00.000Z]");
    expect(block).toContain("  Yes, I created the summary page.");
    expect(block).toContain("[Tool result]");
    expect(block).toContain(
      "  Canvas saved to /Users/me/.stella/outputs/html/nvidia.html",
    );
  });

  it("returns null when there is no usable history", () => {
    expect(
      buildVoiceConversationHistoryBlock([
        { role: "user", content: "   " },
      ]),
    ).toBeNull();
  });
});
