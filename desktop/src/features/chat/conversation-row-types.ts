import type { ReactNode } from "react";
import type {
  Attachment,
  ChannelEnvelope,
} from "@/features/chat/lib/event-transforms";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import type { AgentResponseTarget } from "@/features/chat/streaming/streaming-types";
import type { SelfModApplied } from "@/features/chat/self-mod-types";
import type { OfficePreviewRef } from "../../../../runtime/contracts/office-preview.js";
import type { VoiceSessionSummaryMetadata } from "../../../../runtime/contracts/local-chat.js";
import type { ScheduleToolAffectedRef } from "../../../../runtime/kernel/shared/scheduling";

export type UserRowViewModel = {
  kind: "user";
  id: string;
  text: string;
  /** True only for the freshly-sent user bubble — drives the entry animation. */
  justSent?: boolean;
  windowLabel?: string;
  windowPreviewImageUrl?: string;
  appSelectionLabel?: string;
  activityLabel?: string;
  attachments: Attachment[];
  channelEnvelope?: ChannelEnvelope;
};

export type AssistantRowViewModel = {
  kind: "assistant";
  /**
   * React key for this row. Stable across the streaming -> persisted
   * transition: a row that responds to user message `U` keeps the same
   * `id` whether it is fed by the streaming buffer or loaded from the
   * persisted `assistant_message`.
   */
  id: string;
  text: string;
  /**
   * Stable Streamdown cache key. Same value across the streaming ->
   * persisted handoff so the markdown parse cache is reused.
   */
  cacheKey: string;
  /**
   * Set when this row is sourced from a live `StreamingAssistantOverlay`
   * (text still growing). Scroll follow uses `data-scroll-follow-key`
   * + runtime signals from `useLocalAgentStream`.
   */
  isStreaming?: boolean;
  responseTarget?: AgentResponseTarget;
  /** User turn this assistant row belongs to (for inline-image coalescing). */
  replyToUserMessageId?: string;
  officePreviewRef?: OfficePreviewRef;
  resourcePayload?: DisplayPayload;
  /** Orchestrator image_gen inline cards — one group per tool call. */
  inlineImagePayloads?: DisplayPayload[];
  /**
   * Developer-resource source-diff payloads for this turn, in edit
   * order. Populated only when the developer-file-previews setting
   * is on AND the turn touched at least one such file. `.length`
   * doubles as the "N file changes" label; the payloads themselves
   * are pushed into the singleton "Code changes" tab when the user
   * clicks the inline link / summary card.
   */
  sourceDiffPayloads?: DisplayPayload[];
  selfModApplied?: SelfModApplied;
  /**
   * Inline "Scheduled" receipt chip shown after the orchestrator's
   * `Schedule` tool returns. Carries the structured affected entries
   * straight from the tool result so click -> dialog has no race with
   * a separate IPC fetch.
   */
  scheduleReceipt?: {
    affected: ScheduleToolAffectedRef[];
    summary?: string;
  };
  /**
   * Present on the visible assistant message a realtime voice session
   * writes when it ends. Renders the polished "Voice session" summary
   * card in place of the message text body.
   */
  voiceSession?: VoiceSessionSummaryMetadata;
  /**
   * Optional renderer for surface-specific row attachments (e.g. the Store
   * thread's draft confirmation card). Mounted after the markdown body and
   * after built-in inline artifacts.
   *
   * Identity-stable per `customSlotKey` — the row equality comparator only
   * checks `customSlotKey` so re-rendering ancestors don't blow away the
   * memoized row when the renderer closure identity churns.
   */
  customSlot?: ReactNode;
  customSlotKey?: string;
};

export type EventRowViewModel = UserRowViewModel | AssistantRowViewModel;
