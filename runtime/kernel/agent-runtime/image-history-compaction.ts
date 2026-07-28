import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Byte-size backstop for image-heavy model history.
 *
 * The managed relay rejects request bodies over ~20MiB with HTTP 413 before
 * any model sees them (see `runtime/worker/chat-attachment-spill.ts`), and
 * the relay itself parses + re-serializes the JSON body inside a 64MiB
 * runtime. Token-budget pruning fires far too late for bytes: an image is
 * estimated at ~2K tokens but can carry 4.5MB of base64. Without a byte
 * gate, a long screenshot loop overflows the transport while still deep
 * inside the token budget.
 *
 * The predecessor (`stripStaleImageBlocks`) recomputed an image retention
 * budget from scratch on every LLM call, so each new screenshot shifted
 * which old blocks survived and the prompt-cache prefix churned every turn.
 * This module strips rarely and makes the result sticky instead:
 *
 * - Nothing happens until the estimated serialized size crosses the HIGH
 *   watermark. On crossing, image blocks are stripped oldest-first until the
 *   estimate falls under the LOW watermark. The gap between the two is
 *   runway: after one compaction the thread absorbs several more megabytes
 *   of images before the next one, so cache invalidation is per-crossing,
 *   not per-call.
 * - Stripped blocks are remembered per compactor (one compactor per live
 *   Agent, which is long-lived per durable thread). Between crossings every
 *   call re-emits byte-identical placeholders, keeping the prefix stable.
 * - Placeholders are deterministic functions of the block content — no
 *   timestamps, no per-call size recomputation — and stripping walks
 *   oldest-first. So when the sticky memory is lost (history refresh at a
 *   compaction boundary, app restart), the fresh strip-to-LOW recomputation
 *   yields a superset of any earlier strip with identical placeholder text,
 *   and the prefix up to the first genuinely-new strip still matches. That
 *   determinism is what lets this stay purely in-memory instead of
 *   rewriting persisted thread entries.
 * - When a spill directory is configured, stripped images are written to
 *   disk (content-hashed names, so re-spills are idempotent) and the
 *   placeholder points at the file for `view_image` recovery — the backstop
 *   is recoverable, not lossy.
 * - The newest messages are never stripped regardless of size: the model is
 *   usually actively working from them, and oversized single turns are the
 *   composer spill path's job at ingestion.
 */

// ~20MiB relay cap minus headroom for system prompt, tool definitions, and
// JSON overhead. LOW is deliberately well under HIGH — the runway between
// them sets how often a compaction (and its cache invalidation) can fire.
export const IMAGE_HISTORY_HIGH_WATERMARK_BYTES = 16 * 1024 * 1024;
export const IMAGE_HISTORY_LOW_WATERMARK_BYTES = 10 * 1024 * 1024;

/** Trailing messages whose images are never stripped. */
export const IMAGE_HISTORY_PROTECTED_TAIL_MESSAGES = 4;

type ContentBlockLike = {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  name?: string;
  arguments?: unknown;
};

type MessageLike = {
  role: string;
  content: unknown;
};

const PER_MESSAGE_OVERHEAD_BYTES = 200;
const PER_BLOCK_OVERHEAD_BYTES = 64;

const safeStringifyLength = (value: unknown): number => {
  if (value == null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};

const estimateBlockBytes = (
  block: ContentBlockLike,
  placeholderFor: (block: object) => string | undefined,
): number => {
  const placeholder = placeholderFor(block);
  if (placeholder !== undefined) {
    return placeholder.length + PER_BLOCK_OVERHEAD_BYTES;
  }
  switch (block.type) {
    case "text":
      return (block.text?.length ?? 0) + PER_BLOCK_OVERHEAD_BYTES;
    case "thinking":
      return (block.thinking?.length ?? 0) + PER_BLOCK_OVERHEAD_BYTES;
    case "image":
      return (block.data?.length ?? 0) + PER_BLOCK_OVERHEAD_BYTES;
    case "toolCall":
      return (
        (block.name?.length ?? 0) +
        safeStringifyLength(block.arguments) +
        PER_BLOCK_OVERHEAD_BYTES
      );
    default:
      return safeStringifyLength(block) + PER_BLOCK_OVERHEAD_BYTES;
  }
};

/**
 * Approximate serialized JSON bytes of one history message: content string
 * lengths plus flat overheads. Escaping inflation is ignored; the watermark
 * headroom absorbs it. This deliberately mirrors what the wire body costs,
 * unlike token estimates.
 */
export const estimateMessageSerializedBytes = (
  message: MessageLike,
  placeholderFor: (block: object) => string | undefined = () => undefined,
): number => {
  const content = message.content;
  if (typeof content === "string") {
    return content.length + PER_MESSAGE_OVERHEAD_BYTES;
  }
  if (!Array.isArray(content)) {
    return safeStringifyLength(content) + PER_MESSAGE_OVERHEAD_BYTES;
  }
  return content.reduce<number>(
    (sum, block) =>
      sum +
      (block && typeof block === "object"
        ? estimateBlockBytes(block as ContentBlockLike, placeholderFor)
        : safeStringifyLength(block)),
    PER_MESSAGE_OVERHEAD_BYTES,
  );
};

const imageExtensionFromMimeType = (mimeType: string | undefined): string => {
  switch (mimeType?.split(";")[0]?.trim().toLowerCase()) {
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

const approximateDecodedKb = (base64Length: number): number =>
  Math.round((base64Length * 0.75) / 1024);

const buildPlaceholderText = (
  block: ContentBlockLike,
  spilledFilePath: string | null,
): string => {
  const mimeType = block.mimeType ?? "image/png";
  const sizeKb = approximateDecodedKb(block.data?.length ?? 0);
  if (spilledFilePath) {
    return `[Image removed from history to keep the request under the transport size limit: ${mimeType}, ~${sizeKb}KB, saved to ${spilledFilePath}. Use view_image with that path if it is needed again.]`;
  }
  return `[Image removed from history to keep the request under the transport size limit: ${mimeType}, ~${sizeKb}KB. Re-run the tool that produced it if it is needed again.]`;
};

export type ImageHistoryCompactor = {
  apply<T extends MessageLike>(messages: T[]): Promise<T[]>;
};

export const createImageHistoryCompactor = (options?: {
  highWatermarkBytes?: number;
  lowWatermarkBytes?: number;
  protectedTailMessages?: number;
  /**
   * Directory stripped images are spilled into before being replaced by
   * placeholders. Omit to strip without disk recovery (tests, engines with
   * no data dir). Files are content-hashed, so repeated strips of the same
   * block — including after a sticky-memory reset — reuse one file.
   */
  spillDirPath?: string;
}): ImageHistoryCompactor => {
  const highWatermarkBytes =
    options?.highWatermarkBytes ?? IMAGE_HISTORY_HIGH_WATERMARK_BYTES;
  const lowWatermarkBytes =
    options?.lowWatermarkBytes ?? IMAGE_HISTORY_LOW_WATERMARK_BYTES;
  const protectedTailMessages =
    options?.protectedTailMessages ?? IMAGE_HISTORY_PROTECTED_TAIL_MESSAGES;
  const spillDirPath = options?.spillDirPath;

  // Sticky memory: stripped image block -> its placeholder text. Keyed on
  // block object identity, which is stable for the lifetime of the live
  // Agent's message array. Losing it (history refresh, restart) is safe —
  // see the module comment on deterministic recomputation.
  const placeholders = new WeakMap<object, string>();
  const placeholderFor = (block: object): string | undefined =>
    placeholders.get(block);

  const spillImage = async (
    block: ContentBlockLike,
  ): Promise<string | null> => {
    if (!spillDirPath || !block.data) return null;
    try {
      const data = Buffer.from(block.data, "base64");
      const hash = crypto
        .createHash("sha256")
        .update(data)
        .digest("hex")
        .slice(0, 16);
      const filePath = path.join(
        spillDirPath,
        `img-${hash}${imageExtensionFromMimeType(block.mimeType)}`,
      );
      await fs.mkdir(spillDirPath, { recursive: true });
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, data);
      }
      return filePath;
    } catch {
      // Best-effort recovery path; stripping must not fail on disk errors.
      return null;
    }
  };

  const apply = async <T extends MessageLike>(messages: T[]): Promise<T[]> => {
    let effectiveBytes = messages.reduce(
      (sum, message) =>
        sum + estimateMessageSerializedBytes(message, placeholderFor),
      0,
    );

    if (effectiveBytes > highWatermarkBytes) {
      const protectedFrom = Math.max(0, messages.length - protectedTailMessages);
      strip: for (const [index, message] of messages.entries()) {
        if (index >= protectedFrom) break;
        const content = message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as ContentBlockLike[]) {
          if (
            !block ||
            typeof block !== "object" ||
            block.type !== "image" ||
            typeof block.data !== "string" ||
            placeholders.has(block)
          ) {
            continue;
          }
          const blockBytes = block.data.length;
          const placeholder = buildPlaceholderText(
            block,
            await spillImage(block),
          );
          placeholders.set(block, placeholder);
          effectiveBytes -= blockBytes - placeholder.length;
          if (effectiveBytes <= lowWatermarkBytes) break strip;
        }
      }
    }

    let rewroteAny = false;
    const out = messages.map((message) => {
      const content = message.content;
      if (
        !Array.isArray(content) ||
        !content.some(
          (block) =>
            block && typeof block === "object" && placeholders.has(block),
        )
      ) {
        return message;
      }
      rewroteAny = true;
      return {
        ...message,
        content: content.map((block) => {
          const placeholder =
            block && typeof block === "object"
              ? placeholders.get(block)
              : undefined;
          return placeholder !== undefined
            ? { type: "text", text: placeholder }
            : block;
        }),
      };
    });
    return rewroteAny ? out : messages;
  };

  return { apply };
};
