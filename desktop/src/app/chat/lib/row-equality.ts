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
} from "@/app/chat/lib/event-transforms";
import type { OfficePreviewRef } from "../../../../../runtime/contracts/office-preview.js";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import type { SelfModApplied } from "@/app/chat/SelfModUndoButton";
import type { AskQuestionState } from "@/app/chat/AskQuestionBubble";
import type {
  AssistantRowViewModel,
  EventRowViewModel,
  UserRowViewModel,
} from "@/app/chat/MessageRow";

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
  if (a.featureId !== b.featureId || a.batchIndex !== b.batchIndex) {
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

const askQuestionPayloadEqual = (
  a: AskQuestionState | undefined,
  b: AskQuestionState | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (Boolean(a.submitted) !== Boolean(b.submitted)) return false;
  if (a.questions.length !== b.questions.length) return false;
  for (let i = 0; i < a.questions.length; i += 1) {
    const left = a.questions[i];
    const right = b.questions[i];
    if (left.question !== right.question) return false;
    if (Boolean(left.allowOther) !== Boolean(right.allowOther)) return false;
    if (left.options.length !== right.options.length) return false;
    for (let j = 0; j < left.options.length; j += 1) {
      if (left.options[j].label !== right.options[j].label) return false;
    }
    const leftSelection = a.selections?.[i];
    const rightSelection = b.selections?.[i];
    if (leftSelection?.kind !== rightSelection?.kind) return false;
    if (
      leftSelection?.kind === "option" &&
      rightSelection?.kind === "option" &&
      leftSelection.key !== rightSelection.key
    ) {
      return false;
    }
    if (
      leftSelection?.kind === "other" &&
      rightSelection?.kind === "other" &&
      leftSelection.text !== rightSelection.text
    ) {
      return false;
    }
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

const userRowEqual = (a: UserRowViewModel, b: UserRowViewModel): boolean =>
  a.id === b.id &&
  a.text === b.text &&
  Boolean(a.justSent) === Boolean(b.justSent) &&
  (a.windowLabel ?? null) === (b.windowLabel ?? null) &&
  (a.windowPreviewImageUrl ?? null) === (b.windowPreviewImageUrl ?? null) &&
  attachmentsEqual(a.attachments, b.attachments) &&
  channelEnvelopeEqual(a.channelEnvelope, b.channelEnvelope);

const assistantRowEqual = (
  a: AssistantRowViewModel,
  b: AssistantRowViewModel,
): boolean =>
  a.id === b.id &&
  a.text === b.text &&
  a.cacheKey === b.cacheKey &&
  Boolean(a.isAnimating) === Boolean(b.isAnimating) &&
  JSON.stringify(a.responseTarget ?? null) ===
    JSON.stringify(b.responseTarget ?? null) &&
  (a.officePreviewRef?.sessionId ?? null) ===
    (b.officePreviewRef?.sessionId ?? null) &&
  resourcePayloadEqual(a.resourcePayload, b.resourcePayload) &&
  sourceDiffPayloadsEqual(a.sourceDiffPayloads, b.sourceDiffPayloads) &&
  selfModAppliedEqual(a.selfModApplied, b.selfModApplied) &&
  scheduleReceiptEqual(a.scheduleReceipt, b.scheduleReceipt) &&
  askQuestionPayloadEqual(a.askQuestion, b.askQuestion) &&
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
