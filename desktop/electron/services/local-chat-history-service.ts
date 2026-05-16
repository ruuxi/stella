import { DatabaseSync } from "node:sqlite";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../runtime/kernel/storage/database-init.js";
import { prepareStoredLocalChatPayload } from "../../../runtime/kernel/storage/local-chat-payload.js";
import { SessionStore } from "../../../runtime/kernel/storage/session-store.js";
import type {
  LocalChatAppendEventArgs,
  LocalChatEventRecord,
  LocalChatSyncMessage,
  SqliteDatabase,
} from "../../../runtime/kernel/storage/shared.js";
import type { LocalChatUpdatedPayload } from "../../../runtime/contracts/local-chat.js";
import type { LocalChatEventWindowMode } from "../../../runtime/chat-event-visibility.js";

type LocalChatHistoryServiceOptions = {
  stellaRoot: string;
  onUpdated?: (payload: LocalChatUpdatedPayload | null) => void;
};

const openNodeSqliteDatabase = (dbPath: string): SqliteDatabase =>
  new DatabaseSync(dbPath) as unknown as SqliteDatabase;

export class LocalChatHistoryService {
  private db: SqliteDatabase | null = null;
  private store: SessionStore | null = null;
  private readonly stellaRoot: string;
  private readonly onUpdated?: (payload: LocalChatUpdatedPayload | null) => void;
  private resetInProgress = false;

  constructor(options: LocalChatHistoryServiceOptions) {
    this.stellaRoot = options.stellaRoot;
    this.onUpdated = options.onUpdated;
    this.open();
  }

  private open(): void {
    const db = openNodeSqliteDatabase(getDesktopDatabasePath(this.stellaRoot));
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

  listEvents(args: {
    conversationId: string;
    maxItems?: number;
    windowBy?: LocalChatEventWindowMode;
  }): LocalChatEventRecord[] {
    return this.getStore().listEvents(args.conversationId, args.maxItems, args.windowBy);
  }

  listEventsBefore(args: {
    conversationId: string;
    beforeTimestampMs: number;
    beforeId?: string;
    limit?: number;
  }): LocalChatEventRecord[] {
    return this.getStore().listEventsBefore(args.conversationId, {
      beforeTimestampMs: args.beforeTimestampMs,
      beforeId: args.beforeId,
      limit: args.limit,
    });
  }

  getEventCount(args: {
    conversationId: string;
    countBy?: LocalChatEventWindowMode;
  }): number {
    return this.getStore().getEventCount(args.conversationId, args.countBy);
  }

  appendEvent(args: LocalChatAppendEventArgs): LocalChatEventRecord {
    const event = this.getStore().appendEvent(args);
    this.onUpdated?.({
      conversationId: args.conversationId,
      event: event as unknown as LocalChatUpdatedPayload["event"],
    });
    return event;
  }

  persistDiscoveryWelcome(args: {
    conversationId: string;
    message: string;
    suggestions?: unknown[];
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

    const suggestions = Array.isArray(args.suggestions) ? args.suggestions : [];
    if (suggestions.length > 0) {
      latestEvent = store.appendEvent({
        conversationId: args.conversationId,
        type: "home_suggestions",
        payload: { suggestions },
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

  listSyncMessages(args: {
    conversationId: string;
    maxMessages?: number;
  }): LocalChatSyncMessage[] {
    return this.getStore().listSyncMessages(args.conversationId, args.maxMessages);
  }

  getSyncCheckpoint(args: { conversationId: string }): string | null {
    return this.getStore().getSyncCheckpoint(args.conversationId);
  }

  setSyncCheckpoint(args: {
    conversationId: string;
    localMessageId: string;
  }): { ok: true } {
    this.getStore().setSyncCheckpoint(args.conversationId, args.localMessageId);
    return { ok: true };
  }
}
