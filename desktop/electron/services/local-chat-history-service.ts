import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileChange } from "../../../runtime/contracts/file-changes.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../runtime/kernel/storage/database-init.js";
import { prepareStoredLocalChatPayload } from "../../../runtime/kernel/storage/local-chat-payload.js";
import { SessionStore } from "../../../runtime/kernel/storage/session-store.js";
import type {
  LocalChatActivityWindow,
  LocalChatAppendEventArgs,
  LocalChatEventRecord,
  LocalChatFilesWindow,
  LocalChatMessageRecord,
  LocalChatMessageWindow,
  SqliteDatabase,
} from "../../../runtime/kernel/storage/shared.js";
import type {
  LocalChatUpdatedPayload,
  TaskDecorationUpdatedPayload,
  ThreadActivityRecord,
} from "../../../runtime/contracts/local-chat.js";
import {
  buildMobileSyncMessagesPage,
  buildMobileSyncMessages,
  decodeMobileSyncCursor,
  type LocalChatMobileSyncResult,
  type LocalChatSyncMessageWithArtifacts,
} from "./local-chat-artifacts.js";

type LocalChatHistoryServiceOptions = {
  stellaAppDir: string;
  onUpdated?: (payload: LocalChatUpdatedPayload | null) => void;
  /**
   * Fired when the mirrored task decoration (statusText / reasoning
   * summaries) changes. Wired to a mobile-only broadcast — desktop windows
   * maintain their own decoration stores from the live stream.
   */
  onTaskDecorationUpdated?: (payload: TaskDecorationUpdatedPayload) => void;
};

type FirstReportPayload = {
  slug: string;
  title: string;
  html: string;
};

const REPORT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const normalizeReportSlug = (value: unknown): string => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const slug = raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return REPORT_SLUG_RE.test(slug) ? slug : "welcome";
};

const normalizeFirstReport = (value: unknown): FirstReportPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const html = typeof record.html === "string" ? record.html : "";
  if (!title || !html.trim()) return null;
  return {
    slug: normalizeReportSlug(record.slug),
    title,
    html,
  };
};

const openNodeSqliteDatabase = (dbPath: string): SqliteDatabase =>
  new DatabaseSync(dbPath) as unknown as SqliteDatabase;

const MOBILE_TASK_EVENT_TYPES = new Set([
  "agent-started",
  "agent-progress",
  "agent-completed",
  "agent-failed",
  "agent-canceled",
]);

const taskAgentIdsInMessages = (
  messages: readonly LocalChatMessageRecord[],
) => {
  const touched = new Set<string>();
  const anchored = new Set<string>();
  for (const message of messages) {
    for (const event of message.toolEvents) {
      if (!MOBILE_TASK_EVENT_TYPES.has(event.type)) continue;
      const agentId =
        typeof event.payload?.agentId === "string"
          ? event.payload.agentId.trim()
          : "";
      if (!agentId) continue;
      touched.add(agentId);
      if (event.type === "agent-started") anchored.add(agentId);
    }
  }
  return { touched, anchored };
};

const mergeTaskContextMessages = (
  messages: readonly LocalChatMessageRecord[],
  extra: readonly LocalChatMessageRecord[],
): LocalChatMessageRecord[] => {
  const byId = new Map<string, LocalChatMessageRecord>();
  for (const message of [...extra, ...messages]) {
    const existing = byId.get(message._id);
    if (!existing) {
      byId.set(message._id, message);
      continue;
    }
    const events = new Map(
      [...existing.toolEvents, ...message.toolEvents].map((event) => [
        event._id,
        event,
      ]),
    );
    byId.set(message._id, {
      ...existing,
      ...message,
      toolEvents: [...events.values()].sort(
        (a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id),
      ),
    });
  }
  return [...byId.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a._id.localeCompare(b._id),
  );
};

export class LocalChatHistoryService {
  private db: SqliteDatabase | null = null;
  private store: SessionStore | null = null;
  private readonly stellaAppDir: string;
  private readonly onUpdated?: (
    payload: LocalChatUpdatedPayload | null,
  ) => void;
  private readonly onTaskDecorationUpdated?: (
    payload: TaskDecorationUpdatedPayload,
  ) => void;
  private resetInProgress = false;
  /**
   * Latest per-agent reasoning summaries mirrored from the renderer's
   * `agentProgressSummaryStore` via `publishReasoningSummaries`. The mobile
   * sync serializer attaches these to each task's `reasoningSummaries` so the
   * mobile activity tray shows the SAME phrases the desktop tray generated —
   * the summaries are renderer-generated only and never persisted to SQLite,
   * so they ride this in-memory snapshot instead. Replaced wholesale on each
   * publish; only the currently-running agents are present.
   */
  private reasoningSummariesByAgent = new Map<string, string[]>();
  /**
   * Latest per-agent mid-run statusText mirrored from the renderer's
   * task-decoration store via `publishTaskDecoration`. Same lifecycle as the
   * reasoning summaries above: in-memory only, replaced wholesale per publish,
   * present only for running threads (the renderer clears a thread's
   * decoration on its terminal stream event).
   */
  private statusTextByAgent = new Map<string, string>();
  /** Last decoration payload serialization, so repeat publishes don't re-broadcast. */
  private lastTaskDecorationSerialized = "";

  constructor(options: LocalChatHistoryServiceOptions) {
    this.stellaAppDir = options.stellaAppDir;
    this.onUpdated = options.onUpdated;
    this.onTaskDecorationUpdated = options.onTaskDecorationUpdated;
    this.open();
  }

  private open(): void {
    const db = openNodeSqliteDatabase(getDesktopDatabasePath(this.stellaAppDir));
    initializeDesktopDatabase(db);
    this.db = db;
    this.store = new SessionStore(db);
  }

  private getStore(): SessionStore {
    if (this.resetInProgress) {
      throw new Error("Local chat history is resetting.");
    }
    if (!this.store) {
      this.open();
    }
    if (!this.store) {
      throw new Error("Local chat history store is unavailable.");
    }
    return this.store;
  }

  close(): void {
    const db = this.db;
    this.db = null;
    this.store = null;
    db?.close();
  }

  closeForReset(): void {
    this.resetInProgress = true;
    this.close();
  }

  reopen(): void {
    this.close();
    this.open();
    this.resetInProgress = false;
  }

  getOrCreateDefaultConversationId(): string {
    return this.getStore().getOrCreateDefaultConversationId();
  }

  createNewDefaultConversationId(): string {
    return this.getStore().createNewDefaultConversationId();
  }

  setActiveConversationId(conversationId: string): { ok: true } {
    this.getStore().setActiveDefaultConversationId(conversationId);
    return { ok: true };
  }

  listEvents(args: {
    conversationId: string;
    maxItems?: number;
  }): LocalChatEventRecord[] {
    return this.getStore().listEvents(args.conversationId, args.maxItems);
  }

  listMessages(args: {
    conversationId: string;
    maxVisibleMessages?: number;
  }): LocalChatMessageWindow {
    return this.getStore().listMessages(args.conversationId, {
      maxVisibleMessages: args.maxVisibleMessages,
    });
  }

  listMessagesBefore(args: {
    conversationId: string;
    beforeTimestampMs: number;
    beforeId: string;
    maxVisibleMessages?: number;
  }): LocalChatMessageWindow {
    return this.getStore().listMessagesBefore(args.conversationId, {
      beforeTimestampMs: args.beforeTimestampMs,
      beforeId: args.beforeId,
      maxVisibleMessages: args.maxVisibleMessages,
    });
  }

  /**
   * Changed-rows query for the renderer's tail-only refresh: new
   * user/assistant messages after the cursor plus existing rows whose turn
   * gained tool-derived artifacts after it. The mobile-sync `sourceEvents`
   * are dropped — the renderer merge only needs the message rows.
   */
  listMessagesAfter(args: {
    conversationId: string;
    afterTimestampMs: number;
    afterId: string;
    maxVisibleMessages?: number;
  }): LocalChatMessageWindow {
    const { messages, visibleMessageCount } =
      this.getStore().listMessagesAfter(args.conversationId, {
        afterTimestampMs: args.afterTimestampMs,
        afterId: args.afterId,
        maxVisibleMessages: args.maxVisibleMessages,
      });
    return { messages, visibleMessageCount };
  }

  listActivity(args: {
    conversationId: string;
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  }): LocalChatActivityWindow {
    return this.getStore().listActivity(args.conversationId, {
      limit: args.limit,
      beforeTimestampMs: args.beforeTimestampMs,
      beforeId: args.beforeId,
    });
  }

  listThreadActivity(args: {
    conversationId: string;
  }): ThreadActivityRecord[] {
    return this.getStore().listThreadActivity(args.conversationId);
  }

  listFiles(args: {
    conversationId: string;
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  }): LocalChatFilesWindow {
    return this.getStore().listFiles(args.conversationId, {
      limit: args.limit,
      beforeTimestampMs: args.beforeTimestampMs,
      beforeId: args.beforeId,
    });
  }

  getEventCount(args: { conversationId: string }): number {
    return this.getStore().getEventCount(args.conversationId);
  }

  appendEvent(args: LocalChatAppendEventArgs): LocalChatEventRecord {
    const event = this.getStore().appendEvent(args);
    this.onUpdated?.({
      conversationId: args.conversationId,
      event: event as unknown as LocalChatUpdatedPayload["event"],
    });
    return event;
  }

  hasEvent(args: {
    conversationId: string;
    eventId: string;
    type?: string;
  }): boolean {
    return this.getStore().hasEvent(args.conversationId, args.eventId, args.type);
  }

  hasEventId(args: { eventId: string; type?: string }): boolean {
    return this.getStore().hasEventId(args.eventId, args.type);
  }

  persistDiscoveryWelcome(args: {
    conversationId: string;
    message: string;
    firstReport?: unknown;
  }): { ok: true } {
    const message = args.message.trim();
    const store = this.getStore();
    let latestEvent: LocalChatEventRecord | undefined;
    if (message.length > 0) {
      latestEvent = store.appendEvent({
        conversationId: args.conversationId,
        type: "assistant_message",
        payload: prepareStoredLocalChatPayload({
          type: "assistant_message",
          payload: { text: message },
          timestamp: Date.now(),
        }),
      });
    }

    const firstReport = normalizeFirstReport(args.firstReport);
    if (firstReport) {
      const timestamp = Date.now();
      const filePath = path.join(
        this.stellaAppDir,
        "outputs",
        "html",
        `${firstReport.slug}.html`,
      );
      void (async () => {
        let kind: "add" | "update" = "add";
        try {
          await fs.access(filePath);
          kind = "update";
        } catch {
          kind = "add";
        }
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, firstReport.html, "utf8");
        const bytes = Buffer.byteLength(firstReport.html, "utf8");
        const event = store.appendEvent({
          conversationId: args.conversationId,
          type: "tool_result",
          requestId: `onboarding-first-report-${timestamp}`,
          timestamp: timestamp + 1,
          payload: {
            toolName: "html",
            result: `Canvas "${firstReport.title}" saved to ${filePath} and opened in the panel.`,
            resultPreview: `Canvas "${firstReport.title}" saved to ${filePath} and opened in the panel.`,
            details: {
              filePath,
              slug: firstReport.slug,
              title: firstReport.title,
              createdAt: timestamp,
              bytes,
            },
            filePath,
            slug: firstReport.slug,
            title: firstReport.title,
            createdAt: timestamp,
            bytes,
            fileChanges: [fileChange(filePath, { type: kind })],
            agentType: "orchestrator",
          },
        });
        this.onUpdated?.({
          conversationId: args.conversationId,
          event: event as unknown as LocalChatUpdatedPayload["event"],
        });
      })().catch((error) => {
        console.warn("[local-chat] Failed to persist first report:", error);
      });
    }

    this.onUpdated?.({
      conversationId: args.conversationId,
      ...(latestEvent
        ? { event: latestEvent as unknown as LocalChatUpdatedPayload["event"] }
        : {}),
    });
    return { ok: true };
  }

  /**
   * Mirror the renderer's generated per-agent reasoning summaries into the
   * in-memory snapshot the mobile sync serializer reads — the current phrases
   * keyed by agent id, replacing the previous snapshot wholesale. When the
   * renderer also sends timestamped `entriesByAgentId`, those are persisted
   * (best-effort) to the shared SQLite store so the runtime worker's Recall
   * agent can report what a running agent was doing as of a specific moment.
   */
  setReasoningSummaries(args: {
    summariesByAgentId: Record<string, readonly string[]>;
    entriesByAgentId?: Record<string, readonly { text: string; atMs: number }[]>;
  }): { ok: true } {
    const next = new Map<string, string[]>();
    for (const [rawAgentId, rawList] of Object.entries(
      args.summariesByAgentId ?? {},
    )) {
      const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
      if (!agentId || !Array.isArray(rawList)) continue;
      const cleaned: string[] = [];
      for (const entry of rawList) {
        if (typeof entry !== "string") continue;
        const text = entry.trim();
        if (text) cleaned.push(text);
      }
      if (cleaned.length > 0) next.set(agentId, cleaned);
    }
    this.reasoningSummariesByAgent = next;
    if (args.entriesByAgentId && Object.keys(args.entriesByAgentId).length > 0) {
      try {
        this.getStore().replaceAgentProgressSummaries(
          args.entriesByAgentId as Record<
            string,
            readonly { text: string; atMs: number }[]
          >,
        );
      } catch (error) {
        console.warn(
          "[local-chat] Failed to persist agent progress summaries:",
          error,
        );
      }
    }
    this.emitTaskDecorationUpdated();
    return { ok: true };
  }

  /**
   * Mirror the renderer's per-thread mid-run statusText (the task-decoration
   * store) into the in-memory snapshot the mobile sync serializer reads.
   * Progress ticks are no longer persisted as message rows, so this mirror is
   * the only bridge-side source of a running task's current statusText.
   */
  setTaskDecoration(args: {
    statusTextByAgentId: Record<string, string>;
  }): { ok: true } {
    const next = new Map<string, string>();
    for (const [rawAgentId, rawText] of Object.entries(
      args.statusTextByAgentId ?? {},
    )) {
      const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
      const text = typeof rawText === "string" ? rawText.trim() : "";
      if (agentId && text) next.set(agentId, text);
    }
    this.statusTextByAgent = next;
    this.emitTaskDecorationUpdated();
    return { ok: true };
  }

  /**
   * Push the combined decoration snapshot (statusText + reasoning summaries)
   * to the mobile bridge so the phone's activity pill updates mid-run without
   * a persisted event to resync from. Deduped against the last broadcast —
   * reasoning-chunk publishes that don't change either map stay silent.
   */
  private emitTaskDecorationUpdated(): void {
    if (!this.onTaskDecorationUpdated) return;
    const payload: TaskDecorationUpdatedPayload = {
      statusTextByAgentId: Object.fromEntries(this.statusTextByAgent),
      reasoningSummariesByAgentId: Object.fromEntries(
        this.reasoningSummariesByAgent,
      ),
    };
    const serialized = JSON.stringify(payload);
    if (serialized === this.lastTaskDecorationSerialized) return;
    this.lastTaskDecorationSerialized = serialized;
    this.onTaskDecorationUpdated(payload);
  }

  listSyncMessages(args: {
    conversationId: string;
    maxMessages?: number;
    includeDeveloperArtifacts?: boolean;
  }): LocalChatSyncMessageWithArtifacts[] {
    const maxMessages = Math.max(1, Math.floor(args.maxMessages ?? 100));
    const { messages } = this.getStore().listMessages(args.conversationId, {
      maxVisibleMessages: maxMessages,
    });
    return buildMobileSyncMessages(
      messages,
      maxMessages,
      {
        includeDeveloperArtifacts: args.includeDeveloperArtifacts === true,
      },
      this.reasoningSummariesByAgent,
      messages,
      this.statusTextByAgent,
    );
  }

  syncMessages(args: {
    conversationId: string;
    sinceCursor?: string | null;
    maxMessages?: number;
    includeDeveloperArtifacts?: boolean;
  }): LocalChatMobileSyncResult {
    const maxMessages = Math.max(1, Math.floor(args.maxMessages ?? 100));
    const artifactOptions = {
      includeDeveloperArtifacts: args.includeDeveloperArtifacts === true,
    };
    const cursor = decodeMobileSyncCursor(args.sinceCursor);
    if (cursor) {
      if (
        !this.getStore().hasMobileSyncEventsAfter(
          args.conversationId,
          cursor.timestamp,
          cursor.id,
        )
      ) {
        return { messages: [], cursor: args.sinceCursor?.trim() || null };
      }
      const { messages, sourceEvents } = this.getStore().listMessagesAfter(
        args.conversationId,
        {
          afterTimestampMs: cursor.timestamp,
          afterId: cursor.id,
          maxVisibleMessages: maxMessages,
        },
      );
      const { touched, anchored } = taskAgentIdsInMessages(messages);
      const missingAnchors = [...touched].filter(
        (agentId) => !anchored.has(agentId),
      );
      const targetedTaskContext =
        missingAnchors.length > 0
          ? this.getStore().listMobileTaskContext(
              args.conversationId,
              missingAnchors,
            ).messages
          : [];
      const taskContextMessages = mergeTaskContextMessages(
        messages,
        targetedTaskContext,
      );
      return buildMobileSyncMessagesPage(
        messages,
        maxMessages,
        sourceEvents,
        artifactOptions,
        this.reasoningSummariesByAgent,
        taskContextMessages,
        this.statusTextByAgent,
      );
    }

    const { messages } = this.getStore().listMessages(args.conversationId, {
      maxVisibleMessages: maxMessages,
    });
    return buildMobileSyncMessagesPage(
      messages,
      maxMessages,
      messages,
      artifactOptions,
      this.reasoningSummariesByAgent,
      messages,
      this.statusTextByAgent,
    );
  }

  getSyncCheckpoint(args: { conversationId: string }): string | null {
    return this.getStore().getSyncCheckpoint(args.conversationId);
  }

  setSyncCheckpoint(args: { conversationId: string; localMessageId: string }): {
    ok: true;
  } {
    this.getStore().setSyncCheckpoint(args.conversationId, args.localMessageId);
    return { ok: true };
  }
}
