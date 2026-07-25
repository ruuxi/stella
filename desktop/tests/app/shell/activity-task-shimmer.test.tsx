// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivityTaskShimmer,
  isTopLevelActivityShimmerEligible,
} from "@/shell/ActivityTaskShimmer";
import {
  CHAT_ACTIVITY_SHIMMER_GROUP,
  TextShimmer,
} from "@/app/chat/TextShimmer";
import type { TaskItem } from "@/features/chat/lib/event-transforms";

const task = (overrides: Partial<TaskItem> = {}): TaskItem => ({
  id: "activity-agent",
  description: "Inspect the active work",
  agentType: "general",
  status: "running",
  startedAtMs: Date.now() - 60_000,
  lastUpdatedAtMs: Date.now(),
  ...overrides,
});

describe("left-sidebar Activity shimmer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let animate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    document.documentElement.removeAttribute("data-reduce-motion");
    animate = vi.fn(function (this: HTMLElement) {
      return {
        cancel: vi.fn(),
        finished: new Promise<void>(() => {}),
      };
    });
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.documentElement.removeAttribute("data-reduce-motion");
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  const render = async (node: ReactNode) => {
    await act(async () => {
      root.render(node);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("animates an active top-level General even beside the global working label", async () => {
    await render(
      <>
        <TextShimmer
          text="Working"
          exclusiveGroup={CHAT_ACTIVITY_SHIMMER_GROUP}
          exclusivePriority={100}
        />
        <ActivityTaskShimmer
          task={task({ agentType: "general" })}
          text="Inspect the active work"
          isTopLevel
        />
      </>,
    );

    const activitySweep = container.querySelector(
      ".activity-task-shimmer .text-shimmer__sweep",
    );
    expect(activitySweep).not.toBeNull();
    expect(animate.mock.contexts).toContain(activitySweep);
    expect(container.querySelectorAll(".text-shimmer__sweep")).toHaveLength(2);
  });

  it("animates an authoritative Manager with an old start and newer progress", async () => {
    const oldButActiveManager = task({
      id: "manager-thread",
      agentType: "manager",
      attemptGeneration: 19,
      startedAtMs: Date.now() - 10 * 60_000,
      lastUpdatedAtMs: Date.now(),
      statusText: "Continue reconciling the active batch",
    });
    expect(isTopLevelActivityShimmerEligible(oldButActiveManager, true)).toBe(
      true,
    );

    await render(
      <ActivityTaskShimmer
        task={oldButActiveManager}
        text="Coordinate active work"
        isTopLevel
      />,
    );

    expect(
      container.querySelector(".activity-task-shimmer .text-shimmer__sweep"),
    ).not.toBeNull();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({
      duration: 1700,
      easing: "ease-in-out",
    });
    expect(animate.mock.calls[0]?.[0]).toEqual([
      { transform: "translate3d(-100%, 0, 0)" },
      { transform: "translate3d(calc(100% / 0.44), 0, 0)" },
    ]);
  });

  it("animates the active follow-up while its superseded occurrence stays static", async () => {
    await render(
      <>
        <ActivityTaskShimmer
          task={task({
            id: "general-thread",
            status: "completed",
            attemptGeneration: 2,
          })}
          text="Original occurrence"
          isTopLevel
        />
        <ActivityTaskShimmer
          task={task({
            id: "general-thread",
            status: "running",
            attemptGeneration: 3,
            lastUpdatedAtMs: Date.now(),
          })}
          text="Apply Rahul's follow-up"
          isTopLevel
        />
      </>,
    );

    expect(container.querySelectorAll(".activity-task-shimmer")).toHaveLength(
      1,
    );
    expect(container.textContent).toContain("Original occurrence");
    expect(container.textContent).toContain("Apply Rahul's follow-up");
  });

  it("animates every simultaneously running top-level Activity row", async () => {
    await render(
      <>
        {Array.from({ length: 10 }, (_, index) => (
          <ActivityTaskShimmer
            key={index}
            task={task({
              id: `agent-${index}`,
              agentType: index % 3 === 0 ? "manager" : "general",
            })}
            text={`Concurrent work ${index}`}
            isTopLevel
          />
        ))}
      </>,
    );

    expect(
      container.querySelectorAll(".activity-task-shimmer .text-shimmer__sweep"),
    ).toHaveLength(10);
    expect(animate).toHaveBeenCalledTimes(20);
  });

  it.each(["completed", "error", "canceled"] as const)(
    "keeps %s Activity rows static",
    async (status) => {
      await render(
        <ActivityTaskShimmer
          task={task({ status })}
          text={`${status} work`}
          isTopLevel
        />,
      );
      expect(container.querySelector(".text-shimmer__sweep")).toBeNull();
      expect(animate).not.toHaveBeenCalled();
    },
  );

  it("keeps nested and hidden active rows static", async () => {
    await render(
      <>
        <ActivityTaskShimmer
          task={task({ id: "nested" })}
          text="Nested work"
          isTopLevel={false}
        />
        <div hidden>
          <ActivityTaskShimmer
            task={task({ id: "hidden" })}
            text="Hidden work"
            isTopLevel
          />
        </div>
      </>,
    );

    expect(container.querySelector(".text-shimmer__sweep")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it("keeps active Activity static under reduced motion", async () => {
    document.documentElement.setAttribute("data-reduce-motion", "reduce");
    await render(
      <ActivityTaskShimmer
        task={task()}
        text="Reduced motion work"
        isTopLevel
      />,
    );

    expect(container.querySelector(".text-shimmer__sweep")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });
});
