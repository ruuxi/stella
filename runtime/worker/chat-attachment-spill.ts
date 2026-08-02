import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES } from "../ai/utils/image-caps.js";
import type { RuntimeAttachmentRef } from "../protocol/index.js";

/**
 * Total decoded bytes of composer images allowed inline on a single chat
 * turn. Past this, the request body (system prompt + history + base64
 * images) risks blowing provider/relay request-size caps — the Stella
 * relay rejects bodies over ~20MiB with HTTP 413 before any model sees
 * them, and the oversized user message then poisons every later turn in
 * the thread. Over-budget turns write the images to disk and reference
 * them by absolute path so the model pulls in specific ones on demand via
 * `Read`.
 */
export const INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES = 10 * 1024 * 1024;

export type SpilledImageAttachment = {
  filePath: string;
  mimeType: string;
  bytes: number;
  attachmentIndex?: number;
};

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/i;

const normalizeMimeType = (value: string | null | undefined): string =>
  value?.split(";")[0]?.trim().toLowerCase() ?? "";

const imageExtensionFromMimeType = (mimeType: string): string => {
  switch (mimeType) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".png";
  }
};

export const approximateDataUrlBytes = (url: string): number => {
  const match = DATA_URL_RE.exec(url);
  return Math.floor(((match?.[2]?.length ?? 0) * 3) / 4);
};

/**
 * Per-image cap, measured on the base64 payload — Anthropic rejects any
 * single image whose base64 exceeds its direct-API limit with a fatal 400. A
 * turn whose total is under the spill budget can still carry one such image,
 * so the spill decision checks both. Sourced from the shared `image-caps`
 * definition so this can't drift from the resize target and send boundary.
 */
export const MAX_INLINE_IMAGE_BASE64_BYTES =
  ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES;

export const dataUrlBase64Length = (url: string): number =>
  DATA_URL_RE.exec(url)?.[2]?.length ?? 0;

export const spillImageAttachmentsToDisk = async (args: {
  stellaDataDirPath: string;
  conversationId: string;
  attachments: RuntimeAttachmentRef[];
}): Promise<SpilledImageAttachment[]> => {
  const dir = path.join(
    args.stellaDataDirPath,
    "cache",
    "chat-attachments",
    args.conversationId.replace(/[^a-zA-Z0-9_-]/g, "-"),
  );
  await fs.mkdir(dir, { recursive: true });
  const stamp = `${Date.now()}-${randomUUID()}`;
  const spilled: SpilledImageAttachment[] = [];
  for (const [index, attachment] of args.attachments.entries()) {
    const match = DATA_URL_RE.exec(attachment.url);
    if (!match) continue;
    const mimeType =
      normalizeMimeType(attachment.mimeType) || normalizeMimeType(match[1]);
    const data = Buffer.from(match[2] ?? "", "base64");
    const filePath = path.join(
      dir,
      `${stamp}-${index + 1}${imageExtensionFromMimeType(mimeType)}`,
    );
    await fs.writeFile(filePath, data);
    spilled.push({
      filePath,
      mimeType,
      bytes: data.length,
      attachmentIndex: index,
    });
  }
  return spilled;
};

export const attachPersistedImagePaths = (
  attachments: RuntimeAttachmentRef[],
  persisted: SpilledImageAttachment[],
): RuntimeAttachmentRef[] => {
  const pathByAttachmentIndex = new Map(
    persisted.map((file, index) => [
      file.attachmentIndex ?? index,
      file.filePath,
    ]),
  );
  return attachments.map((attachment, index) => {
    const sourcePath = pathByAttachmentIndex.get(index);
    return sourcePath ? { ...attachment, sourcePath } : attachment;
  });
};

export const buildSpilledAttachmentNotice = (
  spilled: SpilledImageAttachment[],
): string => {
  const formatMegabytes = (bytes: number) =>
    `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return [
    `The user attached ${spilled.length === 1 ? "an image" : `${spilled.length} images`} with this message. The set was too large to inline into the conversation, so the files were saved to disk instead:`,
    ...spilled.map(
      (file, index) =>
        `${index + 1}. ${file.filePath} (${file.mimeType}, ${formatMegabytes(file.bytes)})`,
    ),
    `Use the Read tool with file_path set to these absolute paths to inspect whichever images the request needs — read a few at a time rather than all at once. When delegating work that depends on them, pass the file paths along in the agent prompt.`,
  ].join("\n");
};
