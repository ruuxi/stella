/**
 * Field-wise equality helpers for the turn view-model graph.
 *
 * Lifted out of `MessageTurn.tsx` so non-component modules (notably the
 * `useTurnViewModels` stable-rows pipeline) can share the same comparator
 * tree the `TurnItem` `memo()` wrapper uses. Keeping these in a sibling
 * module also satisfies React Fast Refresh, which only allows component
 * files to re-export components.
 */
import type {
  Attachment,
  ChannelEnvelope,
} from "@/app/chat/lib/event-transforms";
import type { OfficePreviewRef } from "@/shared/contracts/office-preview";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import type { SelfModApplied } from "@/app/chat/SelfModUndoButton";
import type { AskQuestionState } from "@/app/chat/AskQuestionBubble";
import type {
  StreamingTurnProps,
  TurnViewModel,
} from "@/app/chat/MessageTurn";

export function attachmentsEqual(a: Attachment[], b: Attachment[]): boolean {
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

export const channelEnvelopeEqual = (
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

export const selfModAppliedEqual = (
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

export const streamingPropsEqual = (
  a: StreamingTurnProps | undefined,
  b: StreamingTurnProps | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;

  return (
    a.streamingText === b.streamingText &&
    a.reasoningText === b.reasoningText &&
    Boolean(a.isStreaming) === Boolean(b.isStreaming) &&
    (a.pendingUserMessageId ?? null) === (b.pendingUserMessageId ?? null) &&
    Boolean(a.replaceAssistant) === Boolean(b.replaceAssistant) &&
    Boolean(a.appendAsTrailing) === Boolean(b.appendAsTrailing)
  );
};

const trailingAssistantBlocksEqual = (
  a: TurnViewModel["trailingAssistantBlocks"],
  b: TurnViewModel["trailingAssistantBlocks"],
): boolean => {
  const left = a ?? [];
  const right = b ?? [];
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i].id !== right[i].id) return false;
    if (left[i].text !== right[i].text) return false;
    if (left[i].enableEmotes !== right[i].enableEmotes) return false;
  }
  return true;
};

export const askQuestionPayloadEqual = (
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

export const resourcePayloadEqual = (
  a: DisplayPayload | undefined,
  b: DisplayPayload | undefined,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "html":
      return a.html === (b as { html: string }).html;
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
    case "media": {
      const bb = b as Extract<DisplayPayload, { kind: "media" }>;
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

export const turnViewModelEqual = (
  a: TurnViewModel,
  b: TurnViewModel,
): boolean =>
  a === b ||
  (a.id === b.id &&
    a.userText === b.userText &&
    (a.userWindowLabel ?? null) === (b.userWindowLabel ?? null) &&
    (a.userWindowPreviewImageUrl ?? null) ===
      (b.userWindowPreviewImageUrl ?? null) &&
    attachmentsEqual(a.userAttachments, b.userAttachments) &&
    channelEnvelopeEqual(a.userChannelEnvelope, b.userChannelEnvelope) &&
    a.assistantText === b.assistantText &&
    a.assistantMessageId === b.assistantMessageId &&
    JSON.stringify(a.assistantResponseTarget ?? null) ===
      JSON.stringify(b.assistantResponseTarget ?? null) &&
    a.assistantEmotesEnabled === b.assistantEmotesEnabled &&
    (a.webSearchBadgeHtml ?? null) === (b.webSearchBadgeHtml ?? null) &&
    (a.officePreviewRef?.sessionId ?? null) ===
      (b.officePreviewRef?.sessionId ?? null) &&
    resourcePayloadEqual(a.resourcePayload, b.resourcePayload) &&
    askQuestionPayloadEqual(a.askQuestion, b.askQuestion) &&
    selfModAppliedEqual(a.selfModApplied, b.selfModApplied) &&
    trailingAssistantBlocksEqual(
      a.trailingAssistantBlocks,
      b.trailingAssistantBlocks,
    ));
