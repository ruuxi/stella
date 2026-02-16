import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import type { TurnViewModel } from "./MessageTurn";
import type { TaskItem } from "../../hooks/use-conversation-events";
import { useVirtualizer } from "@tanstack/react-virtual";

// Mock useTurnViewModels — we control what it returns per test
const mockUseTurnViewModels = vi.fn();
vi.mock("./use-turn-view-models", () => ({
  useTurnViewModels: (...args: unknown[]) => mockUseTurnViewModels(...args),
}));

// Mock TurnItem and StreamingIndicator
vi.mock("./MessageTurn", async () => {
  const actual = await vi.importActual<typeof import("./MessageTurn")>(
    "./MessageTurn",
  );
  return {
    ...actual,
    TurnItem: ({ turn, streaming }: { turn: TurnViewModel; streaming?: any }) => (
      <div data-testid={`turn-${turn.id}`} data-has-streaming={streaming ? "true" : "false"}>
        {turn.userText}
      </div>
    ),
    StreamingIndicator: ({ streamingText }: { streamingText?: string }) => (
      <div data-testid="streaming-indicator">Streaming: {streamingText ?? ""}</div>
    ),
  };
});

// Mock TaskIndicator as a simple div
vi.mock("../../components/chat/TaskIndicator", () => ({
  TaskIndicator: ({ tasks }: { tasks: TaskItem[] }) => (
    <div data-testid="task-indicator">Tasks: {tasks.length}</div>
  ),
}));

// Mock @tanstack/react-virtual for virtualized list tests
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: vi.fn().mockReturnValue({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    measureElement: vi.fn(),
  }),
}));

import { ConversationEvents } from "./ConversationEvents";

const mockUseVirtualizer = vi.mocked(useVirtualizer);

/** Helper to set up mock return values for useTurnViewModels */
function setMockTurnViewModels(overrides: {
  turns?: TurnViewModel[];
  showStreaming?: boolean;
  showStandaloneStreaming?: boolean;
  processedStreamingText?: string;
  processedReasoningText?: string;
  runningTool?: string | undefined;
  runningTasks?: TaskItem[];
}) {
  mockUseTurnViewModels.mockReturnValue({
    turns: [],
    showStreaming: false,
    showStandaloneStreaming: false,
    processedStreamingText: "",
    processedReasoningText: "",
    runningTool: undefined,
    runningTasks: [],
    ...overrides,
  });
}

const makeTurn = (id: string, userText: string): TurnViewModel => ({
  id,
  userText,
  userAttachments: [],
  userChannelEnvelope: undefined,
  assistantText: "",
  assistantMessageId: null,
  assistantEmotesEnabled: false,
});

beforeEach(() => {
  mockUseTurnViewModels.mockReset();
});

describe("ConversationEvents", () => {
  it("shows 'Start a conversation' when there are no turns and not streaming", () => {
    setMockTurnViewModels({ turns: [], showStreaming: false });

    render(<ConversationEvents events={[]} />);
    expect(screen.getByText("Start a conversation")).toBeInTheDocument();
  });

  it("has the event-list class on the container", () => {
    setMockTurnViewModels({ turns: [], showStreaming: false });

    const { container } = render(<ConversationEvents events={[]} />);
    expect(container.querySelector(".event-list")).toBeTruthy();
  });

  it("has the event-empty class on the empty message", () => {
    setMockTurnViewModels({ turns: [], showStreaming: false });

    const { container } = render(<ConversationEvents events={[]} />);
    expect(container.querySelector(".event-empty")).toBeTruthy();
  });

  it("does not show empty message when streaming with no turns", () => {
    setMockTurnViewModels({
      turns: [],
      showStreaming: true,
      showStandaloneStreaming: true,
    });

    render(<ConversationEvents events={[]} />);
    expect(screen.queryByText("Start a conversation")).not.toBeInTheDocument();
  });

  it("renders a TurnItem for each turn", () => {
    const turns = [makeTurn("t1", "Hello"), makeTurn("t2", "World")];
    setMockTurnViewModels({ turns });

    render(<ConversationEvents events={[]} />);
    expect(screen.getByTestId("turn-t1")).toBeInTheDocument();
    expect(screen.getByTestId("turn-t2")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("World")).toBeInTheDocument();
  });

  it("renders StreamingIndicator when showStandaloneStreaming is true", () => {
    setMockTurnViewModels({
      turns: [],
      showStreaming: true,
      showStandaloneStreaming: true,
    });

    render(<ConversationEvents events={[]} />);
    expect(screen.getByTestId("streaming-indicator")).toBeInTheDocument();
  });

  it("does not render StreamingIndicator when showStandaloneStreaming is false", () => {
    setMockTurnViewModels({
      turns: [makeTurn("t1", "Hi")],
      showStreaming: true,
      showStandaloneStreaming: false,
    });

    render(<ConversationEvents events={[]} />);
    expect(screen.queryByTestId("streaming-indicator")).not.toBeInTheDocument();
  });

  it("renders TaskIndicator when there are running tasks and not streaming", () => {
    const runningTasks: TaskItem[] = [
      {
        id: "task-1",
        description: "Exploring files",
        agentType: "explore",
        status: "running",
      },
    ];
    setMockTurnViewModels({
      turns: [makeTurn("t1", "Do something")],
      showStreaming: false,
      runningTasks,
    });

    render(<ConversationEvents events={[]} />);
    expect(screen.getByTestId("task-indicator")).toBeInTheDocument();
    expect(screen.getByText("Tasks: 1")).toBeInTheDocument();
  });

  it("renders TaskIndicator with multiple tasks", () => {
    const runningTasks: TaskItem[] = [
      { id: "task-1", description: "Task 1", agentType: "explore", status: "running" },
      { id: "task-2", description: "Task 2", agentType: "general", status: "running" },
    ];
    setMockTurnViewModels({
      turns: [makeTurn("t1", "Go")],
      showStreaming: false,
      runningTasks,
    });

    render(<ConversationEvents events={[]} />);
    expect(screen.getByText("Tasks: 2")).toBeInTheDocument();
  });

  it("does not render TaskIndicator when streaming is active", () => {
    const runningTasks: TaskItem[] = [
      {
        id: "task-1",
        description: "Working",
        agentType: "general",
        status: "running",
      },
    ];
    setMockTurnViewModels({
      turns: [makeTurn("t1", "Hi")],
      showStreaming: true,
      runningTasks,
    });

    render(<ConversationEvents events={[]} />);
    expect(screen.queryByTestId("task-indicator")).not.toBeInTheDocument();
  });

  it("does not render TaskIndicator when no running tasks", () => {
    setMockTurnViewModels({
      turns: [makeTurn("t1", "Hi")],
      showStreaming: false,
      runningTasks: [],
    });

    render(<ConversationEvents events={[]} />);
    expect(screen.queryByTestId("task-indicator")).not.toBeInTheDocument();
  });

  it("attaches streaming to a turn matching pendingUserMessageId", () => {
    setMockTurnViewModels({
      turns: [makeTurn("msg-1", "My question")],
      showStreaming: true,
      showStandaloneStreaming: false,
    });

    render(
      <ConversationEvents
        events={[]}
        isStreaming={true}
        pendingUserMessageId="msg-1"
      />,
    );

    const turn = screen.getByTestId("turn-msg-1");
    expect(turn.getAttribute("data-has-streaming")).toBe("true");
  });

  it("does not attach streaming when pendingUserMessageId does not match", () => {
    setMockTurnViewModels({
      turns: [makeTurn("msg-1", "My question")],
      showStreaming: true,
      showStandaloneStreaming: true,
    });

    render(
      <ConversationEvents
        events={[]}
        isStreaming={true}
        pendingUserMessageId="msg-other"
      />,
    );

    const turn = screen.getByTestId("turn-msg-1");
    expect(turn.getAttribute("data-has-streaming")).toBe("false");
  });

  it("uses NonVirtualizedList for < 20 turns (no scrollContainerRef)", () => {
    const turns = Array.from({ length: 5 }, (_, i) =>
      makeTurn(`t${i}`, `Turn ${i}`),
    );
    setMockTurnViewModels({ turns });

    render(<ConversationEvents events={[]} />);

    // All turns should be rendered directly (non-virtualized)
    for (let i = 0; i < 5; i++) {
      expect(screen.getByTestId(`turn-t${i}`)).toBeInTheDocument();
    }
  });

  it("uses NonVirtualizedList even with >= 20 turns when scrollContainerRef is not provided", () => {
    const turns = Array.from({ length: 25 }, (_, i) =>
      makeTurn(`t${i}`, `Turn ${i}`),
    );
    setMockTurnViewModels({ turns });

    // No scrollContainerRef passed — should not virtualize
    render(<ConversationEvents events={[]} />);

    // All turns rendered directly
    for (let i = 0; i < 25; i++) {
      expect(screen.getByTestId(`turn-t${i}`)).toBeInTheDocument();
    }
  });

  it("passes correct parameters to useTurnViewModels", () => {
    setMockTurnViewModels({ turns: [] });

    render(
      <ConversationEvents
        events={[]}
        maxItems={10}
        streamingText="hello"
        reasoningText="thinking"
        isStreaming={true}
        pendingUserMessageId="user-msg-1"
      />,
    );

    expect(mockUseTurnViewModels).toHaveBeenCalledWith({
      events: [],
      maxItems: 10,
      streamingText: "hello",
      reasoningText: "thinking",
      isStreaming: true,
      pendingUserMessageId: "user-msg-1",
    });
  });

  it("is a memoized component (React.memo)", () => {
    // ConversationEvents is exported as memo() wrapping a named function
    expect(ConversationEvents.$$typeof).toBeDefined();
    // memo components have a type property pointing to the inner component
    expect(typeof (ConversationEvents as any).type).toBe("function");
  });

  describe("VirtualizedList", () => {
    /** Helper to create a scrollContainerRef with a real DOM element */
    function makeScrollRef() {
      return { current: document.createElement("div") } as React.RefObject<HTMLDivElement>;
    }

    /** Helper to create virtual items matching a turns array */
    function makeVirtualItems(turns: TurnViewModel[], includeStreaming = false) {
      const items = turns.map((t, i) => ({
        index: i,
        key: t.id,
        start: i * 120,
        size: 120,
        end: (i + 1) * 120,
        lane: 0,
      }));
      if (includeStreaming) {
        items.push({
          index: turns.length,
          key: "streaming" as any,
          start: turns.length * 120,
          size: 120,
          end: (turns.length + 1) * 120,
          lane: 0,
        });
      }
      return items;
    }

    /** Helper to set up the virtualizer mock with items */
    function setupVirtualizerMock(
      virtualItems: ReturnType<typeof makeVirtualItems>,
      totalSize?: number,
    ) {
      const measureElement = vi.fn();
      mockUseVirtualizer.mockReturnValue({
        getVirtualItems: () => virtualItems,
        getTotalSize: () => totalSize ?? virtualItems.length * 120,
        measureElement,
      } as any);
      return { measureElement };
    }

    it("renders VirtualizedList when scrollContainerRef provided and >= 20 turns", () => {
      const turns = Array.from({ length: 25 }, (_, i) =>
        makeTurn(`t${i}`, `Turn ${i}`),
      );
      setMockTurnViewModels({ turns, showStandaloneStreaming: false });

      const virtualItems = makeVirtualItems(turns);
      setupVirtualizerMock(virtualItems);

      const scrollRef = makeScrollRef();
      render(<ConversationEvents events={[]} scrollContainerRef={scrollRef} />);

      // All 25 turns should be rendered via virtualization
      for (let i = 0; i < 25; i++) {
        expect(screen.getByTestId(`turn-t${i}`)).toBeInTheDocument();
      }
    });

    it("VirtualizedList container has correct total height style", () => {
      const turns = Array.from({ length: 20 }, (_, i) =>
        makeTurn(`t${i}`, `Turn ${i}`),
      );
      setMockTurnViewModels({ turns, showStandaloneStreaming: false });

      const virtualItems = makeVirtualItems(turns);
      const totalSize = 2400;
      setupVirtualizerMock(virtualItems, totalSize);

      const scrollRef = makeScrollRef();
      const { container } = render(
        <ConversationEvents events={[]} scrollContainerRef={scrollRef} />,
      );

      // The virtualized container div should have the height from getTotalSize()
      const virtualizerContainer = container.querySelector(
        ".event-list > div",
      ) as HTMLElement;
      expect(virtualizerContainer).toBeTruthy();
      expect(virtualizerContainer.style.height).toBe("2400px");
      expect(virtualizerContainer.style.position).toBe("relative");
    });

    it("VirtualizedList positions items with translateY", () => {
      const turns = Array.from({ length: 20 }, (_, i) =>
        makeTurn(`t${i}`, `Turn ${i}`),
      );
      setMockTurnViewModels({ turns, showStandaloneStreaming: false });

      const virtualItems = makeVirtualItems(turns);
      setupVirtualizerMock(virtualItems);

      const scrollRef = makeScrollRef();
      const { container } = render(
        <ConversationEvents events={[]} scrollContainerRef={scrollRef} />,
      );

      // Check that each virtual item wrapper uses translateY based on its start position
      const itemWrappers = container.querySelectorAll("[data-index]");
      expect(itemWrappers.length).toBe(20);

      itemWrappers.forEach((wrapper, i) => {
        const el = wrapper as HTMLElement;
        expect(el.style.transform).toBe(`translateY(${i * 120}px)`);
        expect(el.style.position).toBe("absolute");
      });
    });

    it("VirtualizedList renders streaming item when showStandaloneStreaming is true", () => {
      const turns = Array.from({ length: 20 }, (_, i) =>
        makeTurn(`t${i}`, `Turn ${i}`),
      );
      setMockTurnViewModels({
        turns,
        showStreaming: true,
        showStandaloneStreaming: true,
      });

      const virtualItems = makeVirtualItems(turns, true);
      setupVirtualizerMock(virtualItems);

      const scrollRef = makeScrollRef();
      render(<ConversationEvents events={[]} scrollContainerRef={scrollRef} isStreaming={true} />);

      // The streaming indicator should be rendered
      expect(screen.getByTestId("streaming-indicator")).toBeInTheDocument();
    });

    it("VirtualizedList attaches streaming to turn matching pendingUserMessageId", () => {
      const turns = Array.from({ length: 20 }, (_, i) =>
        makeTurn(`t${i}`, `Turn ${i}`),
      );
      setMockTurnViewModels({
        turns,
        showStreaming: true,
        showStandaloneStreaming: false,
      });

      const virtualItems = makeVirtualItems(turns);
      setupVirtualizerMock(virtualItems);

      const scrollRef = makeScrollRef();
      render(
        <ConversationEvents
          events={[]}
          scrollContainerRef={scrollRef}
          isStreaming={true}
          pendingUserMessageId="t5"
        />,
      );

      // Turn t5 should have streaming attached
      const turnWithStreaming = screen.getByTestId("turn-t5");
      expect(turnWithStreaming.getAttribute("data-has-streaming")).toBe("true");
    });

    it("VirtualizedList does not attach streaming when IDs don't match", () => {
      const turns = Array.from({ length: 20 }, (_, i) =>
        makeTurn(`t${i}`, `Turn ${i}`),
      );
      setMockTurnViewModels({
        turns,
        showStreaming: true,
        showStandaloneStreaming: false,
      });

      const virtualItems = makeVirtualItems(turns);
      setupVirtualizerMock(virtualItems);

      const scrollRef = makeScrollRef();
      render(
        <ConversationEvents
          events={[]}
          scrollContainerRef={scrollRef}
          isStreaming={true}
          pendingUserMessageId="nonexistent-id"
        />,
      );

      // No turn should have streaming attached
      for (let i = 0; i < 20; i++) {
        const turn = screen.getByTestId(`turn-t${i}`);
        expect(turn.getAttribute("data-has-streaming")).toBe("false");
      }
    });

    it("VirtualizedList passes measureElement as ref to virtual items", () => {
      const turns = Array.from({ length: 20 }, (_, i) =>
        makeTurn(`t${i}`, `Turn ${i}`),
      );
      setMockTurnViewModels({ turns, showStandaloneStreaming: false });

      const virtualItems = makeVirtualItems(turns);
      const { measureElement } = setupVirtualizerMock(virtualItems);

      const scrollRef = makeScrollRef();
      render(
        <ConversationEvents events={[]} scrollContainerRef={scrollRef} />,
      );

      // measureElement should have been called for each rendered virtual item
      // React calls the ref callback when mounting DOM elements
      expect(measureElement).toHaveBeenCalledTimes(20);
    });

    it("VirtualizedList sets data-key and data-index on virtual items", () => {
      const turns = Array.from({ length: 20 }, (_, i) =>
        makeTurn(`t${i}`, `Turn ${i}`),
      );
      setMockTurnViewModels({ turns, showStandaloneStreaming: false });

      const virtualItems = makeVirtualItems(turns);
      setupVirtualizerMock(virtualItems);

      const scrollRef = makeScrollRef();
      const { container } = render(
        <ConversationEvents events={[]} scrollContainerRef={scrollRef} />,
      );

      // Each wrapper div should have data-key and data-index attributes
      turns.forEach((turn, i) => {
        const wrapper = container.querySelector(`[data-key="${turn.id}"]`);
        expect(wrapper).toBeTruthy();
        expect(wrapper!.getAttribute("data-index")).toBe(String(i));
      });
    });

    it("useVirtualizer is called with correct config (count, overscan, etc.)", () => {
      const turns = Array.from({ length: 22 }, (_, i) =>
        makeTurn(`t${i}`, `Turn ${i}`),
      );
      setMockTurnViewModels({
        turns,
        showStandaloneStreaming: true,
        showStreaming: true,
      });

      const virtualItems = makeVirtualItems(turns, true);
      setupVirtualizerMock(virtualItems);

      const scrollRef = makeScrollRef();
      render(
        <ConversationEvents events={[]} scrollContainerRef={scrollRef} isStreaming={true} />,
      );

      // useVirtualizer should have been called with correct configuration
      expect(mockUseVirtualizer).toHaveBeenCalled();
      const callArgs = mockUseVirtualizer.mock.calls[
        mockUseVirtualizer.mock.calls.length - 1
      ][0] as any;

      // count = turns.length + 1 (for streaming)
      expect(callArgs.count).toBe(23);
      expect(callArgs.overscan).toBe(3);
      expect(typeof callArgs.estimateSize).toBe("function");
      expect(typeof callArgs.getScrollElement).toBe("function");
      expect(typeof callArgs.getItemKey).toBe("function");
      expect(typeof callArgs.measureElement).toBe("function");

      // getItemKey should return turn IDs for turn indices and "streaming" for the last
      expect(callArgs.getItemKey(0)).toBe("t0");
      expect(callArgs.getItemKey(21)).toBe("t21");
      expect(callArgs.getItemKey(22)).toBe("streaming");

      // estimateSize should return 120 (default) for items without cache
      expect(callArgs.estimateSize(0)).toBe(120);
    });

    it("VirtualizedList streaming item sets data-key='streaming' and correct data-index", () => {
      const turns = Array.from({ length: 20 }, (_, i) =>
        makeTurn(`t${i}`, `Turn ${i}`),
      );
      setMockTurnViewModels({
        turns,
        showStreaming: true,
        showStandaloneStreaming: true,
      });

      const virtualItems = makeVirtualItems(turns, true);
      setupVirtualizerMock(virtualItems);

      const scrollRef = makeScrollRef();
      const { container } = render(
        <ConversationEvents events={[]} scrollContainerRef={scrollRef} isStreaming={true} />,
      );

      // The streaming wrapper should have data-key="streaming" and data-index equal to turns.length
      const streamingWrapper = container.querySelector('[data-key="streaming"]');
      expect(streamingWrapper).toBeTruthy();
      expect(streamingWrapper!.getAttribute("data-index")).toBe("20");
      expect((streamingWrapper as HTMLElement).style.transform).toBe(
        `translateY(${20 * 120}px)`,
      );
    });
  });
});
