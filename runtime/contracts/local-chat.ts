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

export type ToolRequestPayload = {
  toolName: string;
  args?: Record<string, unknown>;
  targetDeviceId?: string;
  agentType?: string;
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
  featureId: string;
  files: string[];
  batchIndex: number;
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
  };
  trigger?: {
    kind?: string;
    source?: string;
    targetAgentId?: string;
  };
};

/**
 * Chat-timeline view over the underlying append-only event log.
 *
 * `listMessages` projects `user_message` / `assistant_message` rows into
 * `MessageRecord` and attaches each turn's tool/`agent-completed` events
 * to the turn's anchor — first assistant when one exists, otherwise the
 * user_message of the turn. Turn-scoped decoration data (inline
 * artifacts, askQuestion bubbles, schedule receipts, file-change
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
   * Tool/agent-completed events that fired during this message's turn,
   * attached when this message is the turn anchor (first assistant of
   * the turn, or — when no assistant fires — the user_message of the
   * turn). Empty for secondary assistants, hidden messages, and any
   * message that is not the anchor of its turn.
   */
  toolEvents: EventRecord[];
};
