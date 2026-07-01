import { describe, expect, it } from "vitest";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  buildAgentCompletionSections,
  buildAgentMetaMap,
  deriveAgentCompletionFiles,
  type AgentCompletionSection,
} from "@/features/chat/lib/agent-completion";
import { dedupeAgentCompletionRows } from "@/features/chat/hooks/use-event-rows";
import { eventRowEqual } from "@/features/chat/lib/row-equality";
import type {
  AssistantRowViewModel,
  EventRowViewModel,
} from "@/features/chat/conversation-row-types";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";

const ev = (overrides: Partial<EventRecord>): EventRecord => ({
  _id: overrides._id ?? "e",
  timestamp: overrides.timestamp ?? 0,
  type: overrides.type ?? "agent-progress",
  payload: overrides.payload ?? {},
  ...overrides,
});

const started = (
  agentId: string,
  description: string,
  opts: { agentType?: string; groupLabel?: string; timestamp?: number } = {},
): EventRecord =>
  ev({
    _id: `started:${agentId}:${opts.timestamp ?? 1}`,
    timestamp: opts.timestamp ?? 1,
    type: "agent-started",
    payload: {
      agentId,
      description,
      agentType: opts.agentType ?? "general",
      ...(opts.groupLabel ? { groupLabel: opts.groupLabel } : {}),
    },
  });

const completed = (
  agentId: string,
  paths: string[],
  timestamp = 100,
): EventRecord =>
  ev({
    _id: `completed:${agentId}:${timestamp}`,
    timestamp,
    type: "agent-completed",
    payload: {
      agentId,
      result: "done",
      producedFiles: paths.map((path) => ({ kind: { type: "add" }, path })),
    },
  });

describe("deriveAgentCompletionFiles", () => {
  it("groups produced files per agent from a row's agent-completed events", () => {
    const files = deriveAgentCompletionFiles([
      completed("a1", ["/out/report.md"]),
      completed("a2", ["/out/chart.png", "/out/data.csv"]),
    ]);
    expect([...files.keys()].sort()).toEqual(["a1", "a2"]);
    expect(files.get("a1")!.map((f) => f.path)).toEqual(["/out/report.md"]);
    expect(files.get("a2")!.map((f) => f.path).sort()).toEqual([
      "/out/chart.png",
      "/out/data.csv",
    ]);
  });

  it("ignores tool_result events (orchestrator-direct files are not agent pills)", () => {
    const files = deriveAgentCompletionFiles([
      ev({
        _id: "r1",
        type: "tool_result",
        timestamp: 5,
        payload: {
          toolName: "exec_command",
          agentId: "a1",
          producedFiles: [{ kind: { type: "add" }, path: "/out/direct.png" }],
        },
      }),
    ]);
    expect(files.size).toBe(0);
  });

  it("resolves a bare ~/.stella/outputs/html output to a first-class canvas-html payload", () => {
    // The pill must open the Canvas viewer with a slug-derived title, not a
    // generic file artifact — same payload quality the old inline path had.
    const files = deriveAgentCompletionFiles([
      completed("a1", ["/Users/me/.stella/outputs/html/q3-revenue-breakdown.html"], 9),
    ]);
    const entry = files.get("a1")![0]!;
    expect(entry.payload).toMatchObject({
      kind: "canvas-html",
      title: "Q3 Revenue Breakdown",
      slug: "q3-revenue-breakdown",
    });
  });
});

describe("buildAgentCompletionSections", () => {
  it("titles a section from the agent's spawn description and stamps completedAtMs", () => {
    const meta = buildAgentMetaMap([
      started("a1", "Research flights to Tokyo"),
    ]);
    const sections = buildAgentCompletionSections(
      [completed("a1", ["/out/flights.md"], 42)],
      meta,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.agentId).toBe("a1");
    expect(sections[0]!.title).toBe("Research flights to Tokyo");
    expect(sections[0]!.completedAtMs).toBe(42);
    expect(sections[0]!.files.map((f) => f.path)).toEqual(["/out/flights.md"]);
  });

  it("keeps multiple agents sectionalized — never one merged card", () => {
    const meta = buildAgentMetaMap([
      started("a1", "Build the report"),
      started("a2", "Render the chart"),
    ]);
    const sections = buildAgentCompletionSections(
      [
        completed("a1", ["/out/report.md"]),
        completed("a2", ["/out/chart.png"]),
      ],
      meta,
    );
    expect(sections.map((s) => s.agentId)).toEqual(["a1", "a2"]);
    expect(sections.map((s) => s.title)).toEqual([
      "Build the report",
      "Render the chart",
    ]);
  });

  it("keeps reserved builtin agents' files visible (files are user-facing regardless of agent type)", () => {
    // Before the completion-card consolidation these files rendered inline
    // for every agent type; consolidating must not make them vanish from the
    // transcript. (In practice, reserved builtins that could produce noise —
    // fashion, dream, chronicle — run in hidden conversations and never reach
    // the visible transcript at all.)
    const meta = buildAgentMetaMap([
      started("schedule-1", "Schedule a reminder", { agentType: "schedule" }),
    ]);
    const sections = buildAgentCompletionSections(
      [completed("schedule-1", ["/out/x.md"])],
      meta,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Schedule a reminder");
  });

  it("behaves the same whether the spawn meta is present or aged out (generic title fallback)", () => {
    const sections = buildAgentCompletionSections(
      [completed("a1", ["/out/report.md"])],
      new Map(),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("Task");
    expect(sections[0]!.files.map((f) => f.path)).toEqual(["/out/report.md"]);
  });
});

describe("append-only across a send_input re-run", () => {
  it("a later completion carries only its own run's files (per-row scoping)", () => {
    const meta = buildAgentMetaMap([
      started("a1", "Build the report", { timestamp: 1 }),
      started("a1", "Build the report", { timestamp: 50 }),
    ]);
    const firstRow = buildAgentCompletionSections(
      [completed("a1", ["/out/v1.md"], 10)],
      meta,
    );
    const secondRow = buildAgentCompletionSections(
      [completed("a1", ["/out/v2.md"], 60)],
      meta,
    );
    expect(firstRow[0]!.files.map((f) => f.path)).toEqual(["/out/v1.md"]);
    expect(secondRow[0]!.files.map((f) => f.path)).toEqual(["/out/v2.md"]);
    // Distinct completedAtMs — the handoff dedup treats these as separate
    // completions and keeps both cards.
    expect(firstRow[0]!.completedAtMs).not.toBe(secondRow[0]!.completedAtMs);
  });
});

// ---------------------------------------------------------------------------
// Handoff dedup: the same agent-completed projected onto two rows.
// ---------------------------------------------------------------------------

const fileEntry = (path: string, timestamp = 5): ConversationFileEntry => ({
  path,
  timestamp,
  payload: { kind: "markdown", filePath: path, title: path, createdAt: timestamp },
});

const section = (
  agentId: string,
  completedAtMs: number,
  paths: string[],
  title = "Task",
): AgentCompletionSection => ({
  agentId,
  title,
  completedAtMs,
  files: paths.map((p) => fileEntry(p)),
});

const completionRow = (
  id: string,
  sections: AgentCompletionSection[],
  extra: Partial<AssistantRowViewModel> = {},
): AssistantRowViewModel => ({
  kind: "assistant",
  id,
  text: "",
  cacheKey: id,
  agentCompletion: { sections },
  ...extra,
});

describe("dedupeAgentCompletionRows — SQLite/stream handoff", () => {
  it("collapses the same completion double-anchored on the user-fallback and assistant rows", () => {
    const duplicateSections = [section("a1", 42, ["/out/report.md"])];
    const syntheticUserAnchor = completionRow(
      "assistant-agent-activity-u1",
      duplicateSections,
    );
    const assistantAnchor = completionRow("assistant-1", duplicateSections, {
      text: "Here's the report.",
    });
    const rows: EventRowViewModel[] = [syntheticUserAnchor, assistantAnchor];
    const dropped = new Set<number>();
    dedupeAgentCompletionRows(rows, dropped);
    // The later (canonical) row keeps the card; the synthetic
    // completion-only row is dropped entirely.
    expect(dropped).toEqual(new Set([0]));
    expect(
      (rows[1] as AssistantRowViewModel).agentCompletion?.sections,
    ).toHaveLength(1);
  });

  it("strips the duplicate but keeps a row that has other content", () => {
    const duplicateSections = [section("a1", 42, ["/out/report.md"])];
    const earlier = completionRow("assistant-1", duplicateSections, {
      text: "Working on it…",
    });
    const later = completionRow("assistant-2", duplicateSections);
    const rows: EventRowViewModel[] = [earlier, later];
    const dropped = new Set<number>();
    dedupeAgentCompletionRows(rows, dropped);
    expect(dropped.size).toBe(0);
    expect((rows[0] as AssistantRowViewModel).agentCompletion).toBeUndefined();
    expect(
      (rows[1] as AssistantRowViewModel).agentCompletion?.sections,
    ).toHaveLength(1);
  });

  it("keeps distinct completions (send_input re-run) on both rows", () => {
    const first = completionRow("assistant-1", [
      section("a1", 10, ["/out/v1.md"]),
    ]);
    const second = completionRow("assistant-2", [
      section("a1", 60, ["/out/v2.md"]),
    ]);
    const rows: EventRowViewModel[] = [first, second];
    const dropped = new Set<number>();
    dedupeAgentCompletionRows(rows, dropped);
    expect(dropped.size).toBe(0);
    expect((rows[0] as AssistantRowViewModel).agentCompletion).toBeDefined();
    expect((rows[1] as AssistantRowViewModel).agentCompletion).toBeDefined();
  });

  it("strips only the duplicated section on a multi-agent row", () => {
    const shared = section("a1", 42, ["/out/report.md"]);
    const earlier = completionRow("assistant-1", [
      shared,
      section("a2", 43, ["/out/chart.png"]),
    ]);
    const later = completionRow("assistant-2", [shared]);
    const rows: EventRowViewModel[] = [earlier, later];
    const dropped = new Set<number>();
    dedupeAgentCompletionRows(rows, dropped);
    expect(dropped.size).toBe(0);
    expect(
      (rows[0] as AssistantRowViewModel).agentCompletion?.sections.map(
        (s) => s.agentId,
      ),
    ).toEqual(["a2"]);
    expect(
      (rows[1] as AssistantRowViewModel).agentCompletion?.sections.map(
        (s) => s.agentId,
      ),
    ).toEqual(["a1"]);
  });
});

// ---------------------------------------------------------------------------
// agentCompletionEqual (via eventRowEqual) — the comparator the reveal path
// leans on.
// ---------------------------------------------------------------------------

describe("agentCompletion row equality", () => {
  const base = () => completionRow("r1", [section("a1", 42, ["/out/a.md"])]);

  it("equal rows compare equal", () => {
    expect(eventRowEqual(base(), base())).toBe(true);
  });

  it("undefined vs empty sections are not equal", () => {
    const withCard = base();
    const withoutCard: AssistantRowViewModel = {
      kind: "assistant",
      id: "r1",
      text: "",
      cacheKey: "r1",
    };
    expect(eventRowEqual(withCard, withoutCard)).toBe(false);
    const emptyCard = completionRow("r1", []);
    expect(eventRowEqual(emptyCard, withoutCard)).toBe(false);
  });

  it("detects section count change", () => {
    const b = completionRow("r1", [
      section("a1", 42, ["/out/a.md"]),
      section("a2", 43, ["/out/b.md"]),
    ]);
    expect(eventRowEqual(base(), b)).toBe(false);
  });

  it("detects title change", () => {
    const b = completionRow("r1", [
      section("a1", 42, ["/out/a.md"], "New title"),
    ]);
    expect(eventRowEqual(base(), b)).toBe(false);
  });

  it("detects completedAtMs change", () => {
    const b = completionRow("r1", [section("a1", 99, ["/out/a.md"])]);
    expect(eventRowEqual(base(), b)).toBe(false);
  });

  it("detects file path change and reorder", () => {
    const a = completionRow("r1", [
      section("a1", 42, ["/out/a.md", "/out/b.md"]),
    ]);
    const changed = completionRow("r1", [
      section("a1", 42, ["/out/a.md", "/out/c.md"]),
    ]);
    const reordered = completionRow("r1", [
      section("a1", 42, ["/out/b.md", "/out/a.md"]),
    ]);
    expect(eventRowEqual(a, changed)).toBe(false);
    expect(eventRowEqual(a, reordered)).toBe(false);
  });

  it("detects file timestamp change", () => {
    const a = completionRow("r1", [
      { ...section("a1", 42, []), files: [fileEntry("/out/a.md", 5)] },
    ]);
    const b = completionRow("r1", [
      { ...section("a1", 42, []), files: [fileEntry("/out/a.md", 6)] },
    ]);
    expect(eventRowEqual(a, b)).toBe(false);
  });

  it("detects payload kind change", () => {
    const mdEntry = fileEntry("/out/a.md", 5);
    const pdfEntry: ConversationFileEntry = {
      path: "/out/a.md",
      timestamp: 5,
      payload: { kind: "pdf", filePath: "/out/a.md" },
    };
    const a = completionRow("r1", [
      { ...section("a1", 42, []), files: [mdEntry] },
    ]);
    const b = completionRow("r1", [
      { ...section("a1", 42, []), files: [pdfEntry] },
    ]);
    expect(eventRowEqual(a, b)).toBe(false);
  });
});
