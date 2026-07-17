import type { OfficePreviewRef } from "./office-preview.js";
import type { FileChangeRecord, ProducedFileRecord } from "./file-changes.js";

export type EventRecord = {
  _id: string;
  timestamp: number;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
  channelEnvelope?: ChannelEnvelope;
};

export type LocalChatUpdatedPayload = {
  conversationId?: string;
  event?: EventRecord;
};

/**
 * One background-agent thread's authoritative activity state — a direct
 * projection of the runtime's `runtime_agents` row (joined with the thread
 * registry's group fields). This is the single source of truth the Activity
 * UI renders; lifecycle *events* remain the per-occurrence history for chat
 * cards, but never drive thread state.
 */
export type ThreadActivityRecord = {
  threadId: string;
  conversationId: string;
  agentType: string;
  description: string;
  status: "running" | "completed" | "error" | "canceled";
  /** Durable attempt epoch for reused threads. */
  attemptGeneration?: number;
  /** Root run that owns the thread's latest lifecycle. */
  rootRunId?: string;
  parentAgentId?: string;
  groupKey?: string;
  groupLabel?: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  /** Recent text authored by this agent, oldest to newest. This is projected
   * from the existing runtime thread transcript and never model-generated. */
  assistantMessages?: string[];
  /** Timestamp of the newest assistant message included in the bounded
   * projection. Lets clients reject stale in-flight list responses. */
  assistantMessagesUpdatedAt?: number;
  updatedAt: number;
};

/**
 * Bounded replacement for the retired generated-summary stream. Emitted only
 * after a complete, persisted interim assistant message lands for the current
 * attempt of a visible running task. `reasoningSummaries` deliberately mirrors
 * the authored messages for older mobile clients; current clients use the
 * accurately named `assistantMessages` field.
 */
export type ThreadActivityAssistantUpdate = {
  threadId: string;
  assistantMessages: string[];
  /** Legacy mobile wire alias. Contains authored messages, never summaries. */
  reasoningSummaries: string[];
  latestMessage: string;
  atMs: number;
  attemptGeneration: number;
  rootRunId?: string;
};

/** Exact persisted-entry invalidation for an agent transcript. This is kept
 * separate from authored Activity updates so empty tool calls, tool results,
 * Manager coordination, and compaction can refresh an open read-only thread
 * without being presented as agent-authored prose. */
export type ThreadTranscriptUpdate = {
  threadId: string;
  entryId: string;
  atMs: number;
};

export type ThreadActivityUpdatedPayload = {
  conversationId: string;
  /** Present for incremental authored-message delivery; absent for ordinary
   * lifecycle-only invalidations. */
  assistantUpdate?: ThreadActivityAssistantUpdate;
  /** Present when this exact thread gained a durable transcript entry. */
  transcriptUpdate?: ThreadTranscriptUpdate;
};

/** Bounded, read-only projection of one agent thread's persisted transcript. */
export type AgentThreadMessageRecord = {
  entryId?: string;
  timestamp: number;
  role: "user" | "assistant" | "toolResult" | "runtimeInternal";
  content: string;
  toolCallId?: string;
  customMessage?: {
    customType: string;
    content: string | unknown[];
    display: boolean;
    eventId?: string;
  };
};

/**
 * Snapshot of the renderer's ephemeral per-thread status decoration, mirrored
 * to the mobile bridge so the phone's activity pill gets the same mid-run
 * statusText ticks the desktop tray shows. Replaced wholesale on every
 * publish; only currently-running threads are present.
 */
export type TaskDecorationUpdatedPayload = {
  statusTextByAgentId: Record<string, string>;
};

export type ToolRequestPayload = {
  toolName: string;
  args?: Record<string, unknown>;
  targetDeviceId?: string;
  agentType?: string;
};

/**
 * One web search hit as surfaced to the chat UI. Mirrors the backend
 * `SearchHit` (Exa) shape; `image`/`favicon` are only present when the
 * source provided them.
 */
export type WebSearchResultHit = {
  title: string;
  url: string;
  snippet: string;
  image?: string;
  favicon?: string;
};

export type ToolResultPayload = {
  toolName: string;
  result?: unknown;
  resultPreview?: string;
  error?: string;
  requestId?: string;
  agentType?: string;
  officePreviewRef?: OfficePreviewRef;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  /**
   * Structured `web` tool fields, spread onto the persisted payload when
   * the tool ran in search mode (see `runtime/kernel/tools/defs/web.ts`).
   */
  mode?: string;
  query?: string;
  results?: WebSearchResultHit[];
};

export type Attachment = {
  id?: string;
  url?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  kind?: string;
  providerMeta?: unknown;
};

export type ChannelReaction = {
  emoji: string;
  action: "add" | "remove";
  targetMessageId?: string;
};

export type ChannelEnvelope = {
  provider: string;
  kind: "message" | "reaction" | "edit" | "delete" | "system";
  chatType?: string;
  externalUserId?: string;
  externalChatId?: string;
  externalMessageId?: string;
  threadId?: string;
  text?: string;
  attachments?: Attachment[];
  reactions?: ChannelReaction[];
  sourceTimestamp?: number;
  providerPayload?: unknown;
};

/**
 * Self-mod commit produced by the run that authored the surrounding
 * assistant message. Patched onto the assistant payload after `agent_end`
 * by `attachSelfModToAssistantMessage` in the worker so the renderer can
 * render the inline "Undo changes" affordance directly off the persisted
 * row (survives renderer reload, no separate in-memory map).
 */
export type SelfModAppliedPayload = {
  commitHash: string;
  files: string[];
  batchIndex: number;
  status?: "pending" | "applied";
};

export type MessagePayload = {
  text?: string;
  contextText?: string;
  role?: string;
  source?: string;
  agentType?: string;
  attachments?: Attachment[];
  mode?: string;
  userMessageId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  metadata?: MessageMetadata;
  selfModApplied?: SelfModAppliedPayload;
};

export type MessageMetadata = {
  ui?: {
    visibility?: "visible" | "hidden";
  };
  context?: {
    windowLabel?: string;
    windowPreviewImageUrl?: string;
    appSelectionLabel?: string;
    activityLabel?: string;
    /**
     * Descriptors for each "Pasted text" chip on this turn. `text` is a
     * bounded preview (capped at `PASTED_TEXT_PREVIEW_MAX_CHARS`) so the
     * sent-message chip can show the pasted content on hover, matching the
     * composer chip; `lines`/`chars` describe the full paste.
     */
    pastedTexts?: { text?: string; lines: number; chars: number }[];
  };
  trigger?: {
    kind?: string;
    source?: string;
    targetAgentId?: string;
  };
  /**
   * Set on the single visible assistant message a realtime voice session
   * writes when it ends. Lets the chat surface render a polished
   * "Voice session" summary card instead of parsing the duration back out
   * of the message text.
   */
  voiceSession?: VoiceSessionSummaryMetadata;
};

export type VoiceSessionSummaryMetadata = {
  /** Total wall-clock length of the voice session, in milliseconds. */
  durationMs: number;
};

/**
 * Chat-timeline view over the underlying append-only event log.
 *
 * `listMessages` projects `user_message` / `assistant_message` rows into
 * `MessageRecord` and attaches each turn's tool/agent lifecycle events
 * to the turn's anchor — first assistant when one exists, otherwise the
 * user_message of the turn. Turn-scoped decoration data (inline
 * artifacts, schedule receipts, file-change
 * previews) lives on the anchor's `toolEvents` rather than being
 * recovered from a flat event stream at render time.
 *
 * The full event log remains accessible via `listEvents` / `listEventsBefore`
 * for activity/files/debug surfaces.
 */
export type MessageRecord = {
  _id: string;
  timestamp: number;
  /**
   * Underlying event type — currently `"user_message"` or
   * `"assistant_message"`. Kept as the raw string (rather than narrowed)
   * so future visible-message kinds don't need a contract bump.
   */
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
  channelEnvelope?: ChannelEnvelope;
  /**
   * Tool/agent lifecycle events that fired during this message's turn,
   * attached when this message is the turn anchor (first assistant of
   * the turn, or — when no assistant fires — the user_message of the
   * turn). Empty for secondary assistants, hidden messages, and any
   * message that is not the anchor of its turn.
   */
  toolEvents: EventRecord[];
};
