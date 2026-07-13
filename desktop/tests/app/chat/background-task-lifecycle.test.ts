import { describe, expect, it } from "vitest";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  buildBackgroundTaskLifecycleIndex,
  resolveBackgroundTaskCardLifecycle,
} from "@/features/chat/lib/background-task-lifecycle";
import {
  getBackgroundWork,
  projectAgentCompletionSections,
} from "@/features/chat/hooks/use-event-rows";

const event = (
  id: string,
  timestamp: number,
  type: string,
  payload: Record<string, unknown>,
): EventRecord => ({ _id: id, timestamp, type, payload });

const started = (args: {
  id: string;
  at: number;
  agentId: string;
  rootRunId: string;
  description: string;
  agentType?: string;
  statusText?: string;
  isFollowUp?: boolean;
  groupKey?: string;
  groupLabel?: string;
}): EventRecord =>
  event(args.id, args.at, "agent-started", {
    agentId: args.agentId,
    rootRunId: args.rootRunId,
    description: args.description,
    agentType: args.agentType ?? "general",
    statusText: args.statusText ?? args.description,
    ...(args.isFollowUp ? { isFollowUp: true } : {}),
    ...(args.groupKey ? { groupKey: args.groupKey } : {}),
    ...(args.groupLabel ? { groupLabel: args.groupLabel } : {}),
  });

const completed = (args: {
  id: string;
  at: number;
  agentId: string;
  rootRunId: string;
  file?: string;
}): EventRecord =>
  event(args.id, args.at, "agent-completed", {
    agentId: args.agentId,
    rootRunId: args.rootRunId,
    result: "Done",
    ...(args.file
      ? { producedFiles: [{ path: args.file, kind: { type: "add" } }] }
      : {}),
  });

const resolveCard = (starts: EventRecord[], allEvents: EventRecord[]) => {
  const descriptor = getBackgroundWork(starts);
  if (!descriptor) throw new Error("expected a background card descriptor");
  const index = buildBackgroundTaskLifecycleIndex(allEvents);
  return {
    descriptor,
    resolved: resolveBackgroundTaskCardLifecycle(
      descriptor.threadIds,
      descriptor.startEventIdsByThread,
      index,
    ),
    index,
  };
};

describe("spawn-anchored background task lifecycle", () => {
  it("settles a spawn_manager card through the shared completion lifecycle", () => {
    const start = started({
      id: "manager-start",
      at: 100,
      agentId: "manager-thread",
      rootRunId: "manager-run",
      description: "Coordinate the launch",
      agentType: "manager",
    });
    const progress = event("manager-progress", 150, "agent-progress", {
      agentId: "manager-thread",
      rootRunId: "manager-run",
      statusText: "Coordinating verification",
    });
    const done = completed({
      id: "manager-done",
      at: 200,
      agentId: "manager-thread",
      rootRunId: "manager-run",
    });

    const { resolved } = resolveCard([start], [start, progress, done]);
    expect(resolved.completedThreadIds).toEqual(["manager-thread"]);
    expect(resolved.progressTexts).toEqual({
      "manager-thread": "Coordinating verification",
    });
    expect(resolved.completionSections).toMatchObject([
      {
        agentId: "manager-thread",
        title: "Coordinate the launch",
        startEventId: "manager-start",
        completionEventId: "manager-done",
      },
    ]);
  });

  it("deduplicates one completion projected by both live and canonical sources", () => {
    const start = started({
      id: "start-1",
      at: 100,
      agentId: "writer",
      rootRunId: "run-1",
      description: "Write report",
    });
    const done = completed({
      id: "done-1",
      at: 200,
      agentId: "writer",
      rootRunId: "run-1",
      file: "/tmp/report.md",
    });

    const { descriptor, resolved, index } = resolveCard(
      [start],
      [start, done, { ...done, payload: { ...done.payload } }],
    );

    expect(descriptor.cardId).toBe("agent-activity:start-1");
    expect(index.byStartEventId).toHaveLength(1);
    expect(resolved.completedThreadIds).toEqual(["writer"]);
    expect(resolved.completionSections).toHaveLength(1);
    expect(resolved.completionSections[0]).toMatchObject({
      startEventId: "start-1",
      completionEventId: "done-1",
      rootRunId: "run-1",
      title: "Write report",
    });
  });

  it("keeps a delayed replay on the original start identity after later turns", () => {
    const start = started({
      id: "start-old",
      at: 100,
      agentId: "researcher",
      rootRunId: "run-old",
      description: "Research visas",
    });
    const done = completed({
      id: "done-old",
      at: 900,
      agentId: "researcher",
      rootRunId: "run-old",
      file: "/tmp/visas.pdf",
    });
    const laterTurns = [
      event("user-2", 300, "user_message", { text: "another question" }),
      event("assistant-2", 400, "assistant_message", { text: "answer" }),
      event("user-3", 700, "user_message", { text: "one more" }),
    ];

    const { descriptor, resolved, index } = resolveCard(
      [start],
      [start, ...laterTurns, done],
    );

    expect(index.startEventIdByLifecycleEventId.get("done-old")).toBe(
      "start-old",
    );
    expect(descriptor.startEventIdsByThread.researcher).toBe("start-old");
    expect(resolved.terminalEventIdsByThread.researcher).toBe("done-old");
    // Completion is payload on the one start card, never a second card state.
    expect(index.byStartEventId).toHaveLength(1);
  });

  it("updates one grouped spawn card as all group members complete", () => {
    const first = started({
      id: "start-a",
      at: 100,
      agentId: "agent-a",
      rootRunId: "run-group",
      description: "Draft brief",
      groupKey: "grp-1",
      groupLabel: "Launch packet",
    });
    const second = started({
      id: "start-b",
      at: 101,
      agentId: "agent-b",
      rootRunId: "run-group",
      description: "Build chart",
      groupKey: "grp-1",
      groupLabel: "Launch packet",
    });
    const events = [
      first,
      second,
      completed({
        id: "done-a",
        at: 200,
        agentId: "agent-a",
        rootRunId: "run-group",
      }),
      completed({
        id: "done-b",
        at: 220,
        agentId: "agent-b",
        rootRunId: "run-group",
      }),
    ];

    const { descriptor, resolved } = resolveCard([first, second], events);
    expect(descriptor.threadIds).toEqual(["agent-a", "agent-b"]);
    expect(descriptor.cardId).toBe("agent-activity:start-a+start-b");
    expect(resolved.completedThreadIds).toEqual(["agent-a", "agent-b"]);
    expect(resolved.completionSections.map((section) => section.title)).toEqual(
      ["Draft brief", "Build chart"],
    );
  });

  it("keeps follow-ups distinct and never retitles them with the original task", () => {
    const original = started({
      id: "start-original",
      at: 100,
      agentId: "dossier",
      rootRunId: "run-original",
      description: "Build the dossier",
    });
    const originalDone = completed({
      id: "done-original",
      at: 200,
      agentId: "dossier",
      rootRunId: "run-original",
    });
    const followUp = started({
      id: "start-follow-up",
      at: 1_000,
      agentId: "dossier",
      rootRunId: "run-follow-up",
      description: "Build the dossier",
      statusText: "Correct the arrival date",
      isFollowUp: true,
    });
    const followUpDone = completed({
      id: "done-follow-up",
      at: 1_200,
      agentId: "dossier",
      rootRunId: "run-follow-up",
    });
    const all = [original, originalDone, followUp, followUpDone];

    const originalCard = resolveCard([original], all);
    const followUpCard = resolveCard([followUp], all);
    expect(originalCard.descriptor.cardId).not.toBe(
      followUpCard.descriptor.cardId,
    );
    expect(originalCard.resolved.completionSections[0]!.title).toBe(
      "Build the dossier",
    );
    expect(followUpCard.resolved.completionSections[0]!.title).toBe(
      "Correct the arrival date",
    );
    expect(
      followUpCard.index.startEventIdByLifecycleEventId.get("done-follow-up"),
    ).toBe("start-follow-up");

    // Completion cards are projected at their own timeline anchors, using
    // exact completion/start identity rather than mutating either start card.
    expect(
      projectAgentCompletionSections([originalDone], originalCard.index),
    ).toMatchObject([
      {
        startEventId: "start-original",
        completionEventId: "done-original",
        title: "Build the dossier",
      },
    ]);
    expect(
      projectAgentCompletionSections([followUpDone], followUpCard.index),
    ).toMatchObject([
      {
        startEventId: "start-follow-up",
        completionEventId: "done-follow-up",
        title: "Correct the arrival date",
      },
    ]);
  });

  it("deduplicates replay copies at the completion anchor by event id", () => {
    const start = started({
      id: "start-replay",
      at: 100,
      agentId: "writer",
      rootRunId: "run-replay",
      description: "Write summary",
    });
    const done = completed({
      id: "done-replay",
      at: 200,
      agentId: "writer",
      rootRunId: "run-replay",
    });
    const index = buildBackgroundTaskLifecycleIndex([start, done, { ...done }]);

    expect(
      projectAgentCompletionSections([done, { ...done }], index),
    ).toHaveLength(1);
  });

  it("uses the start event, not rootRunId, when one root run sends two follow-ups", () => {
    const first = started({
      id: "start-send",
      at: 100,
      agentId: "mailer",
      rootRunId: "same-root",
      description: "Prepare mail",
      statusText: "Correct and send",
      isFollowUp: true,
    });
    const stop = started({
      id: "start-stop",
      at: 200,
      agentId: "mailer",
      rootRunId: "same-root",
      description: "Prepare mail",
      statusText: "STOP send",
      isFollowUp: true,
    });
    const done = completed({
      id: "done-stop",
      at: 300,
      agentId: "mailer",
      rootRunId: "same-root",
    });
    const index = buildBackgroundTaskLifecycleIndex([first, stop, done]);

    expect(index.byStartEventId.get("start-send")?.status).toBe("running");
    expect(index.byStartEventId.get("start-stop")).toMatchObject({
      title: "STOP send",
      status: "completed",
      terminalEventId: "done-stop",
    });
    expect(index.startEventIdByLifecycleEventId.get("done-stop")).toBe(
      "start-stop",
    );
  });

  it("updates progress and failure on the start card without reviving it", () => {
    const start = started({
      id: "start-fail",
      at: 100,
      agentId: "builder",
      rootRunId: "run-fail",
      description: "Build archive",
    });
    const progress = event("progress-fail", 150, "agent-progress", {
      agentId: "builder",
      rootRunId: "run-fail",
      statusText: "Compressing files",
      toolActivity: {
        toolCallId: "call-1",
        toolName: "exec_command",
        label: "exec_command exited 0",
        state: "completed",
        exitCode: 0,
      },
    });
    const failed = event("failed-1", 200, "agent-failed", {
      agentId: "builder",
      rootRunId: "run-fail",
      error: "disk full",
    });
    const lateProgress = event("progress-late", 210, "agent-progress", {
      agentId: "builder",
      rootRunId: "run-fail",
      statusText: "Should not revive",
    });

    const { resolved, index } = resolveCard(
      [start],
      [start, progress, failed, lateProgress],
    );
    expect(resolved.failedThreadIds).toEqual(["builder"]);
    expect(resolved.progressTexts.builder).toBe("Compressing files");
    expect(resolved.toolActivities.builder).toMatchObject({
      toolName: "exec_command",
      state: "completed",
      exitCode: 0,
    });
    expect(resolved.terminalEventIdsByThread.builder).toBe("failed-1");
    expect(index.byStartEventId.get("start-fail")).toMatchObject({
      status: "failed",
      latestEventId: "failed-1",
      errorText: "disk full",
    });
  });
});
