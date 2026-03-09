import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationEvents } from "../../../../src/app/chat/ConversationEvents";

describe("ConversationEvents", () => {
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

  it("renders turns directly without virtualization", () => {
    const events = Array.from({ length: 25 }, (_, index) => ({
      _id: `user-${index}`,
      timestamp: index,
      type: "user_message",
      payload: { text: `Message ${index}` },
    }));

    render(
      <ConversationEvents events={events} />,
    );

    expect(screen.getByText("Message 24")).toBeInTheDocument();
    expect(screen.getByText("Message 0")).toBeInTheDocument();
  });

  it("shows empty state when no events", () => {
    render(
      <ConversationEvents events={[]} />,
    );

    expect(screen.getByText("Start a conversation")).toBeInTheDocument();
  });
});
