import type { ReactNode } from "react";
import type {
  Attachment,
  ChannelEnvelope,
} from "@/features/chat/lib/event-transforms";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import type { AgentResponseTarget } from "@/features/chat/streaming/streaming-types";
import type { SelfModApplied } from "@/features/chat/self-mod-types";
import type { WebSearchImageHit } from "@/features/chat/lib/derive-turn-web-search";
import type { TurnMapArtifact } from "@/features/chat/lib/derive-turn-map-artifacts";
import type { PastedTextDescriptor } from "@/features/chat/lib/paste-context";
import type { ToolActivityGroup } from "@/features/chat/lib/tool-activity";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
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
  /** Descriptors for the "Pasted text" chips lifted out of the composer. */
  pastedTexts?: PastedTextDescriptor[];
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
   * "Results from the web" image strip — thumbnails from the turn's most
   * recent `web` search (Claude-style). Only image-bearing hits, capped to
   * a single row. See `deriveTurnWebSearchResults`.
   */
  webSearchResults?: WebSearchImageHit[];
  /**
   * Inline interactive map cards from this turn's `map` tool calls (the
   * shared `map-route` artifact rendered via the hosted stella.sh embed).
   * See `deriveTurnMapArtifacts`.
   */
  mapArtifacts?: TurnMapArtifact[];
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
   * Collapsed, expandable trace of the tool calls this row's turn ran after
   * its text (one summary line, Claude-Code-style: "Read 3 files and
   * searched code"). Derived from the row's `toolEvents` slice, counting only
   * settled calls — so it appears once the first tool returns and ticks up as
   * each subsequent one finishes, while the in-flight call stays owned by the
   * footer working indicator. Delegation tools are excluded — those surface
   * through `backgroundWork` instead.
   */
  toolActivity?: ToolActivityGroup;
  /**
   * Inline "background work" card for a turn that kicked off (or updated)
   * one or more background threads (orchestrator `spawn_agent` /
   * `send_input`). Multiple in the same turn collapse onto one card —
   * `threadIds` carries every thread it covers and the card tallies them.
   * `completedThreadIds` is the reload-safe subset whose `agent-completed`
   * event has landed in the message stream; the inline card itself is a
   * static "started here" receipt (see `BackgroundWorkCard`) and no longer
   * renders live running/error/cancel narration. `supersededThreadIds` is the subset a LATER
   * turn's card now owns — this (earlier) card freezes them as settled so it
   * doesn't re-animate when the thread is revived. `label` is the optional
   * friendly group label.
   */
  backgroundWork?: {
    threadIds: string[];
    completedThreadIds: string[];
    /** Reload-safe subset whose latest `agent-canceled` postdates this card's
     *  spawn (and any completion) — the thread was paused (the orchestrator's
     *  pause_agent lands as a cancel; the runtime treats non-running threads
     *  as paused/resumable). The card renders a "Paused" label and stops its
     *  shimmer for these; a resume (`send_input`) emits a fresh
     *  `agent-started` whose newer card supersedes this one. */
    pausedThreadIds?: string[];
    supersededThreadIds?: string[];
    /** Per-thread work description (the spawn's user-friendly summary),
     *  used as the card title — mirrors the sidebar Activity surface. */
    descriptions: Record<string, string>;
    /** Per-thread follow-up text for threads re-activated via `send_input` on
     *  this turn. A `send_input` reuses the thread's original `description`, so
     *  this carries the follow-up's own message/description for the card title;
     *  absent for plain spawns. See `getBackgroundWork`. */
    statusTexts?: Record<string, string>;
    /** Threads on this card that are `send_input` follow-ups (an update to an
     *  already-spawned thread) rather than fresh spawns — drives the distinct
     *  "follow-up" card variant. */
    followUpThreadIds?: string[];
    /** Per-thread spawn/last-advanced time (ms). Lets the card presume a
     *  long-silent thread with no live signal is settled rather than pinning
     *  it as forever-working when its lifecycle aged out of the windows. */
    spawnedAtMs?: Record<string, number>;
    groupKey?: string;
    label?: string;
  };
  /**
   * Delegated-agent completion card, anchored to the assistant row the
   * `agent-completed` lifecycle event attaches to (the chronological
   * completion point in the transcript). Each section is one agent — its own
   * header + its own produced-file pills; several agents completing at the
   * same point stay sectionalized, never flattened into one merged card. This
   * is the "done + pills" surface; the spawn/working breadcrumb stays at the
   * spawn position via `backgroundWork`. Populated only on the row where the
   * completion lands, and only for delegated (non-reserved) agents that
   * produced files — so it's append-only across `send_input` re-runs by
   * construction (each completion carries only that run's files on its own
   * row).
   */
  agentCompletion?: {
    sections: AgentCompletionSection[];
  };
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
