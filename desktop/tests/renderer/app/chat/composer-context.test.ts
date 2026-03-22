import { describe, expect, it } from "vitest";
import { deriveComposerState } from "../../../../src/app/chat/composer-context";

describe("deriveComposerState", () => {
  it("returns the default placeholder and disabled submit state with no input", () => {
    const state = deriveComposerState({ message: "" });

    expect(state.placeholder).toBe("Ask anything");
    expect(state.canSubmit).toBe(false);
    expect(state.contextState.hasComposerContext).toBe(false);
  });

  it("keeps capture-pending UI visible without treating it as sendable context", () => {
    const state = deriveComposerState({
      message: "",
      chatContext: { capturePending: true },
    });

    expect(state.placeholder).toBe("Capturing screen...");
    expect(state.contextState.hasComposerContext).toBe(true);
    expect(state.contextState.hasPendingCaptureContext).toBe(true);
    expect(state.canSubmit).toBe(false);
  });

  it("treats extracted window text as submit-ready window context", () => {
    const state = deriveComposerState({
      message: "",
      chatContext: { windowText: "Draft reply to customer" },
    });

    expect(state.placeholder).toBe("Ask about this window...");
    expect(state.contextState.hasWindowTextContext).toBe(true);
    expect(state.canSubmit).toBe(true);
  });

  it("respects conversation gating when a surface requires a conversation id", () => {
    const state = deriveComposerState({
      message: "hello",
      requireConversationId: true,
      conversationId: null,
    });

    expect(state.canSubmit).toBe(false);
    expect(state.hasMessage).toBe(true);
  });
});
