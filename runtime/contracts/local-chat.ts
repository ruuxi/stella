import type { OfficePreviewRef } from "./office-preview.js";
import type { FileChangeRecord, ProducedFileRecord } from "./file-changes.js";
import type { AgentModelConfigSnapshot } from "./agent-engine.js";

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

/** One Activity row. Stella-managed rows project `runtime_agents` and remain
 * execution-authoritative; Claude-native rows are durable observational
 * projections only. `source` is the mandatory control/aggregation fence. */
export type ThreadActivityRecord = {
  /** Execution authority for this row. Claude-native rows are passive,
   * read-only projections and must never enter Stella's agent manager. */
  source: "stella" | "claude-native";
  threadId: string;
  conversationId: string;
  agentType: string;
  description: string;
  status: "running" | "completed" | "error" | "canceled";
  /** Durable attempt epoch for reused threads. */
  attemptGeneration?: number;
  /** Root run that owns the thread's latest lifecycle. */
  rootRunId?: string;
  /** Exact engine/model configuration captured for this thread's run. */
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  parentAgentId?: string;
  /** Claude-native projections are inspectable but cannot be resumed,
   * messaged, paused, or independently canceled through Stella. */
  readOnly?: boolean;
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
  /** Durable append sequence of the newest included assistant message.
   * This is authoritative when several transcript entries share a timestamp. */
  assistantMessagesUpdatedSequence?: number;
  updatedAt: number;
};

/**
 * Bounded replacement for the retired generated-summary stream. Emitted only
 * after complete, persisted assistant prose lands for the current attempt of
 * a visible running task, including its final answer. `reasoningSummaries` mirrors
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
  /** Durable append sequence for equal-timestamp ordering. */
  atSequence?: number;
  attemptGeneration: number;
  rootRunId?: string;
};

/** Exact persisted-entry invalidation for an agent transcript. This is kept
 * separate from authored Activity updates so empty tool calls, tool results,
 * Manager coordination, and compaction can refresh an open read-only thread
 * without being presented as agent-authored prose. */
export type ThreadTranscriptUpdate = {
  source?: "stella" | "claude-native";
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
  /** Durable append cursor. Present for Claude-native transcript rows. */
  sequence?: number;
  source?: "stella" | "claude-native";
  timestamp: number;
  role: "user" | "assistant" | "lifecycle";
  content: string;
  lifecycleEvent?: EventRecord;
};

/** Cursor-paginated read-only transcript page. `nextBeforeSequence` points
 * to the next older page and is absent once history is exhausted. */
export type AgentThreadMessagePage = {
  messages: AgentThreadMessageRecord[];
  nextBeforeSequence?: number;
  hasMore: boolean;
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
  /**
   * On-disk source path when the attachment came from a disk-backed File
   * (picker / drag-drop). Sent-message file chips use it to open the
   * original in its default app; absent for synthetic files.
   */
  path?: string;
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
  /**
   * Stable card identity — the self-mod run id. The card is built from the
   * run's tracked writes when the run finishes, so it exists before (and
   * independently of) the commit. Absent on rows written before the card was
   * decoupled from commit timing; those identify by `commitHash` alone.
   */
  applyId?: string;
  /** Stable identity of the grouped publication. Equal to `applyId` on new cards. */
  changeSetId?: string;
  /**
   * Set once the run's commit lands. Only Undo needs it, so that affordance
   * stays hidden until it arrives — a run whose commit failed keeps a working
   * Update button and simply never offers Undo.
   */
  commitHash?: string;
  /**
   * Every commit represented by a grouped card, in finalize order. Multi-commit
   * cards omit singular `commitHash` so legacy clients cannot partially undo.
   */
  commitHashes?: string[];
  files: string[];
  batchIndex: number;
  status?: "pending" | "applied" | "reverted";
};

/**
 * A self-mod commit detected in git (a run's baseline..HEAD window). Always
 * carries its hash because it is read straight off a commit — unlike the
 * persisted card above, which is staged from tracked writes and so can exist
 * before any commit does.
 */
export type SelfModCommitAppliedPayload = Omit<
  SelfModAppliedPayload,
  "status"
> & {
  commitHash: string;
  /** Commit-detection events never carry the later chat-card revert state. */
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
    /** Legacy single label (joined when multiple areas were attached). */
    appSelectionLabel?: string;
    /** One label per attached selected-area context, in attach order. */
    appSelectionLabels?: string[];
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
