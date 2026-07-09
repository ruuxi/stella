// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDeferredChatMessages } from "@/features/chat/hooks/use-deferred-chat-messages";
import type { MessageRecord } from "../../../../runtime/contracts/local-chat.js";

const message = (id: string): MessageRecord => ({
  _id: id,
  timestamp: 1,
  type: "assistant_message",
  payload: { text: id },
  toolEvents: [],
});

function Harness({
  messages,
  deferUpdates,
  scopeKey = "conversation-a",
}: {
  messages: MessageRecord[];
  deferUpdates: boolean;
  scopeKey?: string;
}) {
  const painted = useDeferredChatMessages(messages, deferUpdates, scopeKey);
  return <div data-testid="painted">{painted.at(-1)?._id}</div>;
}

describe("useDeferredChatMessages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async (
    messages: MessageRecord[],
    deferUpdates: boolean,
    scopeKey?: string,
  ) => {
    await act(async () => {
      root.render(
        <Harness
          messages={messages}
          deferUpdates={deferUpdates}
          scopeKey={scopeKey}
        />,
      );
    });
    return container.querySelector('[data-testid="painted"]')?.textContent;
  };

  it("holds the painted array while scrolling and flushes the latest afterward", async () => {
    expect(await render([message("first")], false)).toBe("first");
    expect(await render([message("first"), message("second")], true)).toBe(
      "first",
    );
    expect(
      await render(
        [message("first"), message("second"), message("third")],
        true,
      ),
    ).toBe("first");
    expect(
      await render(
        [message("first"), message("second"), message("third")],
        false,
      ),
    ).toBe("third");
  });

  it("switches conversations immediately even during scroll", async () => {
    expect(await render([message("first")], false, "conversation-a")).toBe(
      "first",
    );
    expect(await render([message("other")], true, "conversation-b")).toBe(
      "other",
    );
  });
});
