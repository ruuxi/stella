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
   * Fired when the mirrored task status decoration changes. Wired to a
   * mobile-only broadcast — desktop windows
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
   * Latest per-agent mid-run statusText mirrored from the renderer's
   * task-decoration store via `publishTaskDecoration`. In-memory only,
   * replaced wholesale per publish, and present only for running threads.
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
    const db = openNodeSqliteDatabase(
      getDesktopDatabasePath(this.stellaAppDir),
    );
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

  private getAssistantMessagesByAgent(
    conversationId: string,
  ): Map<string, string[]> {
    return new Map(
      this.getStore()
        .listThreadActivity(conversationId)
        .filter((record) => record.assistantMessages?.length)
        .map((record) => [record.threadId, record.assistantMessages!]),
    );
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
    const { messages, visibleMessageCount } = this.getStore().listMessagesAfter(
      args.conversationId,
      {
        afterTimestampMs: args.afterTimestampMs,
        afterId: args.afterId,
        maxVisibleMessages: args.maxVisibleMessages,
      },
    );
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

  listThreadActivity(args: { conversationId: string }): ThreadActivityRecord[] {
    return this.getStore().listThreadActivity(args.conversationId);
  }

  listAgentThreadMessages(args: { threadId: string; limit?: number }) {
    const threadId = args.threadId.trim();
    if (!threadId) throw new Error("threadId is required.");
    const limit = Math.min(300, Math.max(1, Math.floor(args.limit ?? 200)));
    return this.getStore()
      .loadThreadMessages(threadId, limit)
      .map((message) => ({
        ...(message.entryId ? { entryId: message.entryId } : {}),
        timestamp: message.timestamp,
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.customMessage
          ? { customMessage: message.customMessage }
          : {}),
      }));
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
    return this.getStore().hasEvent(
      args.conversationId,
      args.eventId,
      args.type,
    );
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
   * Mirror the renderer's per-thread mid-run statusText (the task-decoration
   * store) into the in-memory snapshot the mobile sync serializer reads.
   * Progress ticks are no longer persisted as message rows, so this mirror is
   * the only bridge-side source of a running task's current statusText.
   */
  setTaskDecoration(args: { statusTextByAgentId: Record<string, string> }): {
    ok: true;
  } {
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
   * Push the status snapshot to the mobile bridge so the phone's activity pill
   * updates mid-run without a persisted event to resync from.
   */
  private emitTaskDecorationUpdated(): void {
    if (!this.onTaskDecorationUpdated) return;
    const payload: TaskDecorationUpdatedPayload = {
      statusTextByAgentId: Object.fromEntries(this.statusTextByAgent),
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
    const assistantMessagesByAgent = this.getAssistantMessagesByAgent(
      args.conversationId,
    );
    return buildMobileSyncMessages(
      messages,
      maxMessages,
      {
        includeDeveloperArtifacts: args.includeDeveloperArtifacts === true,
      },
      assistantMessagesByAgent,
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
      const assistantMessagesByAgent = this.getAssistantMessagesByAgent(
        args.conversationId,
      );
      return buildMobileSyncMessagesPage(
        messages,
        maxMessages,
        sourceEvents,
        artifactOptions,
        assistantMessagesByAgent,
        taskContextMessages,
        this.statusTextByAgent,
      );
    }

    const { messages } = this.getStore().listMessages(args.conversationId, {
      maxVisibleMessages: maxMessages,
    });
    const assistantMessagesByAgent = this.getAssistantMessagesByAgent(
      args.conversationId,
    );
    return buildMobileSyncMessagesPage(
      messages,
      maxMessages,
      messages,
      artifactOptions,
      assistantMessagesByAgent,
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
