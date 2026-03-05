import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationEvents } from "./ConversationEvents";

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
});
