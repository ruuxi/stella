import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationEvents } from "../../../../src/app/chat/ConversationEvents";

const useVirtualizerMock = vi.fn(() => ({
  getVirtualItems: () => [],
  getTotalSize: () => 0,
  measureElement: () => 0,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (...args: unknown[]) => useVirtualizerMock(...args),
}));

describe("ConversationEvents", () => {
  beforeEach(() => {
    useVirtualizerMock.mockClear();
  });

  it("shows a loading placeholder instead of an empty thread during initial history fetch", () => {
    render(
      <ConversationEvents
        events={[]}
        isLoadingHistory={true}
      />,
    );

    expect(screen.getByText("Loading conversation...")).toBeInTheDocument();
    expect(screen.queryByText("Start a conversation")).toBeNull();
  });

  it("renders existing turns before the scroll container ref is attached", () => {
    const events = Array.from({ length: 21 }, (_, index) => ({
      _id: `user-${index}`,
      timestamp: index,
      type: "user_message",
      payload: { text: `Message ${index}` },
    }));

    render(
      <ConversationEvents
        events={events}
        scrollContainerRef={createRef<HTMLDivElement>()}
      />,
    );

    expect(useVirtualizerMock).not.toHaveBeenCalled();
    expect(screen.getByText("Message 20")).toBeInTheDocument();
  });
});
