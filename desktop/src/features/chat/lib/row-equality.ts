/**
 * Field-wise equality helpers for the linear chat row view-model graph.
 *
 * Lifted out of the row component file so the `useEventRows` stable-rows
 * pipeline can share the same comparator that `<UserMessageRow>` /
 * `<AssistantMessageRow>` `memo()` use, without dragging React component
 * imports into the hook (Fast Refresh).
 */
import type {
  Attachment,
  ChannelEnvelope,
} from "@/features/chat/lib/event-transforms";
import type { OfficePreviewRef } from "../../../../../runtime/contracts/office-preview.js";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import type { SelfModApplied } from "@/features/chat/self-mod-types";
import { toolActivityEqual } from "@/features/chat/lib/tool-activity";
import type {
  AssistantRowViewModel,
  EventRowViewModel,
  UserRowViewModel,
} from "@/features/chat/conversation-row-types";

function attachmentsEqual(a: Attachment[], b: Attachment[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];

    if ((av.id ?? null) !== (bv.id ?? null)) return false;
    if ((av.url ?? null) !== (bv.url ?? null)) return false;
    if ((av.mimeType ?? null) !== (bv.mimeType ?? null)) return false;
    if ((av.name ?? null) !== (bv.name ?? null)) return false;
  }

  return true;
}

const reactionsEqual = (
  a: ChannelEnvelope["reactions"] | undefined,
  b: ChannelEnvelope["reactions"] | undefined,
): boolean => {
  const left = a ?? [];
  const right = b ?? [];
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let i = 0; i < left.length; i += 1) {
    const av = left[i];
    const bv = right[i];
    if (!av || !bv) return false;
    if (av.emoji !== bv.emoji) return false;
    if (av.action !== bv.action) return false;
    if ((av.targetMessageId ?? null) !== (bv.targetMessageId ?? null))
      return false;
  }

  return true;
};

const channelEnvelopeEqual = (
  a: ChannelEnvelope | undefined,
  b: ChannelEnvelope | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;

  return (
    a.provider === b.provider &&
    a.kind === b.kind &&
    reactionsEqual(a.reactions, b.reactions)
  );
};

const selfModAppliedEqual = (
  a: SelfModApplied | undefined,
  b: SelfModApplied | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.commitHash !== b.commitHash || a.batchIndex !== b.batchIndex) {
    return false;
  }
  if ((a.status ?? "applied") !== (b.status ?? "applied")) {
    return false;
  }
  if (a.files.length !== b.files.length) {
    return false;
  }
  for (let i = 0; i < a.files.length; i += 1) {
    if (a.files[i] !== b.files[i]) {
      return false;
    }
  }
  return true;
};

const scheduleReceiptEqual = (
  a: AssistantRowViewModel["scheduleReceipt"],
  b: AssistantRowViewModel["scheduleReceipt"],
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if ((a.summary ?? null) !== (b.summary ?? null)) return false;
  if (a.affected.length !== b.affected.length) return false;
  for (let i = 0; i < a.affected.length; i += 1) {
    const left = a.affected[i];
    const right = b.affected[i];
    if (left.kind !== right.kind) return false;
    if (left.id !== right.id) return false;
    if (left.enabled !== right.enabled) return false;
    if (left.nextRunAtMs !== right.nextRunAtMs) return false;
  }
  return true;
};

const resourcePayloadEqual = (
  a: DisplayPayload | undefined,
  b: DisplayPayload | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "canvas-html": {
      const bb = b as Extract<DisplayPayload, { kind: "canvas-html" }>;
      return (
        a.filePath === bb.filePath &&
        (a.title ?? null) === (bb.title ?? null) &&
        (a.slug ?? null) === (bb.slug ?? null) &&
        a.createdAt === bb.createdAt
      );
    }
    case "office":
      return (
        a.previewRef.sourcePath ===
        (b as { previewRef: OfficePreviewRef }).previewRef.sourcePath
      );
    case "markdown": {
      const bb = b as Extract<DisplayPayload, { kind: "markdown" }>;
      return (
        a.filePath === bb.filePath &&
        (a.createdAt ?? null) === (bb.createdAt ?? null)
      );
    }
    case "source-diff": {
      const bb = b as Extract<DisplayPayload, { kind: "source-diff" }>;
      return (
        a.filePath === bb.filePath &&
        (a.patch ?? null) === (bb.patch ?? null) &&
        (a.createdAt ?? null) === (bb.createdAt ?? null)
      );
    }
    case "file-artifact": {
      const bb = b as Extract<DisplayPayload, { kind: "file-artifact" }>;
      return (
        a.filePath === bb.filePath &&
        a.artifactKind === bb.artifactKind &&
        (a.createdAt ?? null) === (bb.createdAt ?? null)
      );
    }
    case "pdf":
      return a.filePath === (b as { filePath: string }).filePath;
    case "url": {
      const bb = b as Extract<DisplayPayload, { kind: "url" }>;
      return (
        a.url === bb.url &&
        a.title === bb.title &&
        a.tabId === bb.tabId &&
        (a.tooltip ?? null) === (bb.tooltip ?? null)
      );
    }
    case "trash": {
      const bb = b as Extract<DisplayPayload, { kind: "trash" }>;
      return (
        (a.title ?? null) === (bb.title ?? null) &&
        (a.createdAt ?? null) === (bb.createdAt ?? null)
      );
    }
    case "media": {
      const bb = b as Extract<DisplayPayload, { kind: "media" }>;
      if ((a.presentation ?? null) !== (bb.presentation ?? null)) return false;
      if ((a.numImages ?? null) !== (bb.numImages ?? null)) return false;
      if ((a.imageIndex ?? null) !== (bb.imageIndex ?? null)) return false;
      if (a.asset.kind !== bb.asset.kind) return false;
      if (a.asset.kind === "image" && bb.asset.kind === "image") {
        return a.asset.filePaths.join("|") === bb.asset.filePaths.join("|");
      }
      if (
        (a.asset.kind === "video" || a.asset.kind === "audio") &&
        (bb.asset.kind === "video" || bb.asset.kind === "audio")
      ) {
        return a.asset.filePath === bb.asset.filePath;
      }
      return JSON.stringify(a.asset) === JSON.stringify(bb.asset);
    }
  }
};

const sourceDiffPayloadsEqual = (
  a: DisplayPayload[] | undefined,
  b: DisplayPayload[] | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const aa = a[index]!;
    const bb = b[index]!;
    if (aa.kind !== "source-diff" || bb.kind !== "source-diff") {
      if (!resourcePayloadEqual(aa, bb)) return false;
      continue;
    }
    if (aa.filePath !== bb.filePath) return false;
    if ((aa.patch ?? null) !== (bb.patch ?? null)) return false;
    if ((aa.createdAt ?? null) !== (bb.createdAt ?? null)) return false;
  }
  return true;
};

const backgroundWorkEqual = (
  a: AssistantRowViewModel["backgroundWork"],
  b: AssistantRowViewModel["backgroundWork"],
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.cardId !== b.cardId) return false;
  if (a.threadIds.length !== b.threadIds.length) return false;
  if (a.completedThreadIds.length !== b.completedThreadIds.length) return false;
  for (let i = 0; i < a.threadIds.length; i += 1) {
    if (a.threadIds[i] !== b.threadIds[i]) return false;
    if (a.descriptions[a.threadIds[i]] !== b.descriptions[b.threadIds[i]]) {
      return false;
    }
    if (
      (a.statusTexts?.[a.threadIds[i]] ?? null) !==
      (b.statusTexts?.[b.threadIds[i]] ?? null)
    ) {
      return false;
    }
    const threadId = a.threadIds[i]!;
    if (a.spawnedAtMs?.[threadId] !== b.spawnedAtMs?.[threadId]) return false;
    if (
      a.startEventIdsByThread[threadId] !== b.startEventIdsByThread[threadId]
    ) {
      return false;
    }
    if (
      (a.attemptGenerationsByThread?.[threadId] ?? null) !==
      (b.attemptGenerationsByThread?.[threadId] ?? null)
    ) {
      return false;
    }
    if (
      (a.rootRunIdsByThread[threadId] ?? null) !==
      (b.rootRunIdsByThread[threadId] ?? null)
    ) {
      return false;
    }
    if (
      (a.progressTexts?.[threadId] ?? null) !==
      (b.progressTexts?.[threadId] ?? null)
    ) {
      return false;
    }
    const aTool = a.toolActivities?.[threadId];
    const bTool = b.toolActivities?.[threadId];
    if (
      (aTool?.toolCallId ?? null) !== (bTool?.toolCallId ?? null) ||
      (aTool?.toolName ?? null) !== (bTool?.toolName ?? null) ||
      (aTool?.state ?? null) !== (bTool?.state ?? null) ||
      (aTool?.exitCode ?? null) !== (bTool?.exitCode ?? null)
    ) {
      return false;
    }
    if (
      (a.terminalEventIdsByThread?.[threadId] ?? null) !==
      (b.terminalEventIdsByThread?.[threadId] ?? null)
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.completedThreadIds.length; i += 1) {
    if (a.completedThreadIds[i] !== b.completedThreadIds[i]) return false;
  }
  const aPaused = a.pausedThreadIds ?? [];
  const bPaused = b.pausedThreadIds ?? [];
  if (aPaused.length !== bPaused.length) return false;
  for (let i = 0; i < aPaused.length; i += 1) {
    if (aPaused[i] !== bPaused[i]) return false;
  }
  const aFailed = a.failedThreadIds ?? [];
  const bFailed = b.failedThreadIds ?? [];
  if (aFailed.length !== bFailed.length) return false;
  for (let i = 0; i < aFailed.length; i += 1) {
    if (aFailed[i] !== bFailed[i]) return false;
  }
  const aSuperseded = a.supersededThreadIds ?? [];
  const bSuperseded = b.supersededThreadIds ?? [];
  if (aSuperseded.length !== bSuperseded.length) return false;
  for (let i = 0; i < aSuperseded.length; i += 1) {
    if (aSuperseded[i] !== bSuperseded[i]) return false;
  }
  const aFollowUp = a.followUpThreadIds ?? [];
  const bFollowUp = b.followUpThreadIds ?? [];
  if (aFollowUp.length !== bFollowUp.length) return false;
  for (let i = 0; i < aFollowUp.length; i += 1) {
    if (aFollowUp[i] !== bFollowUp[i]) return false;
  }
  if (
    !agentCompletionEqual(
      { sections: a.completionSections ?? [] },
      { sections: b.completionSections ?? [] },
    )
  ) {
    return false;
  }
  return true;
};

const agentCompletionEqual = (
  a: AssistantRowViewModel["agentCompletion"],
  b: AssistantRowViewModel["agentCompletion"],
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.sections.length !== b.sections.length) return false;
  for (let i = 0; i < a.sections.length; i += 1) {
    const as = a.sections[i]!;
    const bs = b.sections[i]!;
    if (as.agentId !== bs.agentId) return false;
    if (as.title !== bs.title) return false;
    if (as.startEventId !== bs.startEventId) return false;
    if (as.completionEventId !== bs.completionEventId) return false;
    if (as.rootRunId !== bs.rootRunId) return false;
    if (as.completedAtMs !== bs.completedAtMs) return false;
    if (as.summary !== bs.summary) return false;
    if (as.files.length !== bs.files.length) return false;
    for (let j = 0; j < as.files.length; j += 1) {
      const af = as.files[j]!;
      const bf = bs.files[j]!;
      if (af.path !== bf.path) return false;
      if (af.timestamp !== bf.timestamp) return false;
      if (af.payload.kind !== bf.payload.kind) return false;
    }
  }
  return true;
};

const webSearchResultsEqual = (
  a: AssistantRowViewModel["webSearchResults"],
  b: AssistantRowViewModel["webSearchResults"],
): boolean => {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].url !== b[i].url) return false;
    if (a[i].image !== b[i].image) return false;
  }
  return true;
};

const mapArtifactsEqual = (
  a: AssistantRowViewModel["mapArtifacts"],
  b: AssistantRowViewModel["mapArtifacts"],
): boolean => {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false;
    // Artifacts are immutable once persisted; id + marker count + polyline
    // identity is enough to detect a different payload on the same slot.
    if (a[i].map.markers.length !== b[i].map.markers.length) return false;
    if (
      (a[i].map.route?.polyline ?? null) !== (b[i].map.route?.polyline ?? null)
    )
      return false;
  }
  return true;
};

const userRowEqual = (a: UserRowViewModel, b: UserRowViewModel): boolean =>
  a.id === b.id &&
  a.text === b.text &&
  Boolean(a.justSent) === Boolean(b.justSent) &&
  (a.windowLabel ?? null) === (b.windowLabel ?? null) &&
  (a.windowPreviewImageUrl ?? null) === (b.windowPreviewImageUrl ?? null) &&
  (a.appSelectionLabel ?? null) === (b.appSelectionLabel ?? null) &&
  (a.activityLabel ?? null) === (b.activityLabel ?? null) &&
  (a.pastedTexts?.length ?? 0) === (b.pastedTexts?.length ?? 0) &&
  attachmentsEqual(a.attachments, b.attachments) &&
  channelEnvelopeEqual(a.channelEnvelope, b.channelEnvelope);

const assistantRowEqual = (
  a: AssistantRowViewModel,
  b: AssistantRowViewModel,
): boolean =>
  a.id === b.id &&
  a.text === b.text &&
  a.cacheKey === b.cacheKey &&
  Boolean(a.isStreaming) === Boolean(b.isStreaming) &&
  (a.replyToUserMessageId ?? null) === (b.replyToUserMessageId ?? null) &&
  JSON.stringify(a.responseTarget ?? null) ===
    JSON.stringify(b.responseTarget ?? null) &&
  (a.officePreviewRef?.sessionId ?? null) ===
    (b.officePreviewRef?.sessionId ?? null) &&
  resourcePayloadEqual(a.resourcePayload, b.resourcePayload) &&
  sourceDiffPayloadsEqual(a.inlineImagePayloads, b.inlineImagePayloads) &&
  sourceDiffPayloadsEqual(a.sourceDiffPayloads, b.sourceDiffPayloads) &&
  webSearchResultsEqual(a.webSearchResults, b.webSearchResults) &&
  mapArtifactsEqual(a.mapArtifacts, b.mapArtifacts) &&
  selfModAppliedEqual(a.selfModApplied, b.selfModApplied) &&
  scheduleReceiptEqual(a.scheduleReceipt, b.scheduleReceipt) &&
  backgroundWorkEqual(a.backgroundWork, b.backgroundWork) &&
  agentCompletionEqual(a.agentCompletion, b.agentCompletion) &&
  toolActivityEqual(a.toolActivity, b.toolActivity) &&
  (a.voiceSession?.durationMs ?? null) ===
    (b.voiceSession?.durationMs ?? null) &&
  // Compare a stable key for the custom slot (the ReactNode itself
  // changes identity on each render of the Store thread). Surfaces
  // that mount a custom slot must supply a key derived from the
  // payload, not from the rendered node.
  (a.customSlotKey ?? null) === (b.customSlotKey ?? null);

export const eventRowEqual = (
  a: EventRowViewModel,
  b: EventRowViewModel,
): boolean => {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === "user" && b.kind === "user") return userRowEqual(a, b);
  if (a.kind === "assistant" && b.kind === "assistant")
    return assistantRowEqual(a, b);
  return false;
};
