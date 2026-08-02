import { promises as fs } from "node:fs";

import {
  detectImageMediaType,
  isCompleteImage,
} from "../../ai/utils/image-payload.js";

/**
 * Read an image file, tolerating the capture -> read race that produces
 * truncated screenshots.
 *
 * The upstream capture paths (stella-browser's Rust CLI, stella-computer's
 * native helper, and any `[stella-attach-image]` marker) hand back a file
 * path once a screenshot is captured. When the runtime reads that path back
 * (auto-attach in `tool-adapters`, or an image path passed to `Read`) it can
 * open the file in the narrow window before the writer's bytes are fully
 * flushed to disk. The reader then gets a structurally *incomplete* image:
 * the PNG signature + IHDR are present so nothing looks wrong, but the stream
 * is cut off before IEND. Anthropic decodes server-side and fails the whole
 * request with a fatal 400 "Could not process image", and because the bad
 * block is persisted in thread history every resume re-sends and re-fails.
 *
 * This guard closes that window at the read boundary: read the file, and if
 * the bytes are a recognized image format that is not yet complete *and the
 * file is still growing*, back off briefly and re-read until it settles
 * (complete), stops changing (genuinely truncated/corrupt on disk — spinning
 * won't help), or the attempt budget is exhausted. A well-behaved capture
 * that already finished its write returns on the first read with no delay.
 *
 * This is the proper upstream fix; the caller still validates the returned
 * bytes and drops anything that never completed, which keeps the existing
 * drop/repair resilience layer as defense-in-depth beneath this guard.
 */

const DEFAULT_MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 15;
const MAX_DELAY_MS = 240;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type ReadImageFileSettledOptions = {
  /** Maximum number of read attempts (>= 1). Defaults to 6. */
  maxAttempts?: number;
  /** Injectable sleep, for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

export const readImageFileSettled = async (
  filePath: string,
  options?: ReadImageFileSettledOptions,
): Promise<Buffer> => {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = options?.sleep ?? delay;

  let buf = await fs.readFile(filePath);
  let previousLength = -1;

  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    const detected = detectImageMediaType(buf);
    if (detected && isCompleteImage(buf, detected)) {
      return buf;
    }
    // The file stopped growing between two reads: the writer is done, so this
    // is a genuinely truncated/corrupt file on disk rather than a capture
    // still mid-flush. Re-reading won't change anything — stop early and let
    // the caller's validation drop it.
    if (buf.length === previousLength) {
      return buf;
    }
    previousLength = buf.length;

    await sleep(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS));
    buf = await fs.readFile(filePath);
  }

  return buf;
};
