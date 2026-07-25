// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  EventRecord,
  MessageRecord,
} from "../../../../runtime/contracts/local-chat.js";
import type { EventRowViewModel } from "@/features/chat/conversation-row-types";
import { useEventRows } from "@/features/chat/hooks/use-event-rows";

const lifecycle = (
  id: string,
  timestamp: number,
  type: string,
  payload: Record<string, unknown>,
): EventRecord => ({ _id: id, timestamp, type, payload });

const assistant = (
  id: string,
  timestamp: number,
  toolEvents: EventRecord[],
): MessageRecord => ({
  _id: id,
  timestamp,
  type: "assistant_message",
  payload: { text: "", userMessageId: "user-turn" },
  toolEvents,
});

const start = (
  id: string,
  timestamp: number,
  agentType: "general",
  generation: number,
  followUp = false,
) =>
  lifecycle(id, timestamp, "agent-started", {
    agentId: `${agentType}-thread`,
    agentType,
    rootRunId: `${agentType}-run`,
    attemptGeneration: generation,
    description: "Original durable work",
    statusText: followUp ? "Apply Rahul's follow-up" : "Original durable work",
    ...(followUp ? { isFollowUp: true } : {}),
  });

const complete = (
  id: string,
  timestamp: number,
  agentType: "general",
  generation: number,
) =>
  lifecycle(id, timestamp, "agent-completed", {
    agentId: `${agentType}-thread`,
    agentType,
    rootRunId: `${agentType}-run`,
    attemptGeneration: generation,
    result: "Finished the occurrence",
  });

describe("inline follow-up card projection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let renderedRows: EventRowViewModel[] = [];

  function Probe({ messages }: { messages: MessageRecord[] }) {
    renderedRows = useEventRows({ messages }).rows;
    return null;
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    renderedRows = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows only the new follow-up card when it interrupts active work", async () => {
    const agentType = "general";
    const original = start("original-start", 100, agentType, 1);
    const followUp = start("follow-up-start", 200, agentType, 2, true);
    await act(async () => {
      root.render(
        <Probe
          messages={[
            assistant("original-row", 100, [original]),
            assistant("follow-up-row", 200, [followUp]),
          ]}
        />,
      );
    });

    const cards = renderedRows.flatMap((row) =>
      row.kind === "assistant" && row.backgroundWork
        ? [row.backgroundWork]
        : [],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.startEventIdsByThread[`${agentType}-thread`]).toBe(
      "follow-up-start",
    );
    expect(cards[0]?.followUpThreadIds).toEqual([`${agentType}-thread`]);
  });

  it("keeps the settled card and adds a separate follow-up card", async () => {
    const agentType = "general";
    const original = start("original-start", 100, agentType, 1);
    const originalDone = complete("original-done", 150, agentType, 1);
    const followUp = start("follow-up-start", 200, agentType, 2, true);
    await act(async () => {
      root.render(
        <Probe
          messages={[
            assistant("original-row", 100, [original]),
            assistant("completion-row", 150, [originalDone]),
            assistant("follow-up-row", 200, [followUp]),
          ]}
        />,
      );
    });

    const cards = renderedRows.flatMap((row) =>
      row.kind === "assistant" && row.backgroundWork
        ? [row.backgroundWork]
        : [],
    );
    expect(cards).toHaveLength(2);
    expect(
      cards.map((card) => card.startEventIdsByThread[`${agentType}-thread`]),
    ).toEqual(["original-start", "follow-up-start"]);
    expect(cards[0]?.completedThreadIds).toEqual([`${agentType}-thread`]);
    expect(cards[0]?.supersededThreadIds).toEqual([`${agentType}-thread`]);
    expect(cards[1]?.completedThreadIds).toEqual([]);
  });

  it("orders a settled predecessor before its newer follow-up when routed onto one row", async () => {
    const agentType = "general";
    const original = start("original-start", 100, agentType, 1);
    const originalDone = complete("original-done", 150, agentType, 1);
    const followUp = start("follow-up-start", 200, agentType, 2, true);
    await act(async () => {
      root.render(
        <Probe
          messages={[
            // Lifecycle routing can move the older start onto an anchor
            // that already carries the newer follow-up. Projection order
            // must follow event chronology, not this merge-array order.
            assistant("shared-row", 100, [followUp, original, originalDone]),
          ]}
        />,
      );
    });

    const cards = renderedRows.flatMap((row) =>
      row.kind === "assistant" && row.backgroundWork
        ? [row.backgroundWork]
        : [],
    );
    expect(
      cards.map((card) => card.startEventIdsByThread[`${agentType}-thread`]),
    ).toEqual(["original-start", "follow-up-start"]);
    expect(cards[0]?.completedThreadIds).toEqual([`${agentType}-thread`]);
    expect(cards[1]?.completedThreadIds).toEqual([]);
  });
});
