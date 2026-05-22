/**
 * Dev-only placeholder content for the chat workspace strip so layout
 * work is visible on an empty conversation. Counts match strip visibility
 * caps (no overflow / history affordance). Stripped from production builds.
 */
import type { TaskItem } from "@/app/chat/lib/event-transforms";
import { buildPayloadFromBarePath } from "@/app/chat/lib/derive-turn-resource";
import type { ConversationFileEntry } from "@/shell/display/derive-conversation-files";
import type { ScheduleEntry } from "@/global/schedule/use-conversation-schedules";

export const WORKSPACE_STRIP_MOCK_ENABLED = import.meta.env.DEV;

/** Keep in sync with ChatWorkspaceStrip NOW_VISIBLE / DONE_VISIBLE / FILES_VISIBLE / UPNEXT_VISIBLE. */
const MOCK_NOW_COUNT = 4;
const MOCK_DONE_COUNT = 4;
const MOCK_FILES_COUNT = 5;
const MOCK_SCHEDULE_COUNT = 4;

const mockNowMs = () => Date.now();

const mockTask = (
  partial: Pick<TaskItem, "id" | "description" | "status"> &
    Partial<TaskItem>,
): TaskItem => {
  const now = mockNowMs();
  return {
    agentType: "general",
    startedAtMs: now - 120_000,
    lastUpdatedAtMs: now - 30_000,
    ...partial,
  };
};

const RUNNING_TASK_SEEDS: ReadonlyArray<
  Pick<TaskItem, "id" | "description"> & Partial<TaskItem>
> = [
  {
    id: "mock-task-running-1",
    description: "Draft launch email variants",
    statusText: "Writing copy",
  },
  {
    id: "mock-task-running-2",
    description: "Summarize yesterday's standup notes",
  },
  {
    id: "mock-task-running-3",
    description: "Wire workspace strip history control",
  },
  {
    id: "mock-task-running-4",
    description: "Refresh store discover mosaic",
  },
];

const DONE_TASK_SEEDS: ReadonlyArray<
  Pick<TaskItem, "id" | "description"> & Partial<TaskItem>
> = [
  {
    id: "mock-task-done-1",
    description: "Polish onboarding carousel copy",
    completedAtMs: mockNowMs() - 8 * 60_000,
  },
  {
    id: "mock-task-done-2",
    description: "Export Q2 roadmap to PDF",
    completedAtMs: mockNowMs() - 22 * 60_000,
  },
  {
    id: "mock-task-done-3",
    description: "Tighten workspace strip spacing",
    completedAtMs: mockNowMs() - 41 * 60_000,
  },
  {
    id: "mock-task-done-4",
    description: "Review competitor pricing pages",
    completedAtMs: mockNowMs() - 2 * 3_600_000,
  },
];

export const mockWorkspaceStripRunningTasks: TaskItem[] =
  RUNNING_TASK_SEEDS.slice(0, MOCK_NOW_COUNT).map((seed) =>
    mockTask({ ...seed, status: "running" }),
  );

export const mockWorkspaceStripDoneTasks: TaskItem[] =
  DONE_TASK_SEEDS.slice(0, MOCK_DONE_COUNT).map((seed) =>
    mockTask({ ...seed, status: "completed" }),
  );

const mockFile = (
  path: string,
  ageMs: number,
): ConversationFileEntry | null => {
  const timestamp = mockNowMs() - ageMs;
  const payload = buildPayloadFromBarePath(path, timestamp);
  if (!payload) return null;
  return { path, timestamp, payload };
};

const FILE_PATH_SEEDS: ReadonlyArray<{ path: string; ageMs: number }> = [
  { path: "/Users/demo/notes/meeting-notes.md", ageMs: 12 * 60_000 },
  { path: "/Users/demo/assets/launch-hero.png", ageMs: 28 * 60_000 },
  { path: "/Users/demo/docs/quarterly-review.pdf", ageMs: 55 * 60_000 },
  {
    path: "/Users/demo/state/outputs/html/product-roadmap.html",
    ageMs: 90 * 60_000,
  },
  { path: "/Users/demo/drafts/announcement.md", ageMs: 3 * 3_600_000 },
];

export const mockWorkspaceStripFiles: ConversationFileEntry[] = FILE_PATH_SEEDS.slice(
  0,
  MOCK_FILES_COUNT,
)
  .map(({ path, ageMs }) => mockFile(path, ageMs))
  .filter((entry): entry is ConversationFileEntry => entry !== null);

export const mockWorkspaceStripSchedules = (nowMs: number): ScheduleEntry[] =>
  (
    [
      {
        kind: "cron" as const,
        id: "mock-cron-briefing",
        name: "Morning briefing",
        enabled: true,
        nextRunAtMs: nowMs + 45 * 60_000,
        schedule: {
          kind: "cron" as const,
          expr: "0 9 * * *",
          tz: "America/Los_Angeles",
        },
      },
      {
        kind: "heartbeat" as const,
        id: "mock-heartbeat-inbox",
        name: "Sweep inbox for follow-ups",
        enabled: true,
        nextRunAtMs: nowMs + 2 * 3_600_000,
        intervalMs: 4 * 3_600_000,
      },
      {
        kind: "cron" as const,
        id: "mock-cron-weekly",
        name: "Weekly planning digest",
        enabled: true,
        nextRunAtMs: nowMs + 26 * 3_600_000,
        schedule: { kind: "every" as const, everyMs: 7 * 24 * 3_600_000 },
      },
      {
        kind: "cron" as const,
        id: "mock-cron-standup",
        name: "Team standup reminder",
        enabled: true,
        nextRunAtMs: nowMs + 3 * 24 * 3_600_000,
        schedule: { kind: "cron" as const, expr: "0 10 * * 1-5", tz: "America/Los_Angeles" },
      },
      {
        kind: "heartbeat" as const,
        id: "mock-heartbeat-docs",
        name: "Review open docs queue",
        enabled: true,
        nextRunAtMs: nowMs + 5 * 24 * 3_600_000,
        intervalMs: 2 * 24 * 3_600_000,
      },
    ] satisfies ScheduleEntry[]
  ).slice(0, MOCK_SCHEDULE_COUNT);
