import { useCallback, useEffect, useRef, useState } from "react";

export type StreamBuffer = {
  text: string;
  append: (delta: string) => void;
  reset: () => void;
};

/**
 * Chunking strategies, mirroring Vercel AI SDK's `smoothStream` options:
 *   - `"word"`: emit one word (run of non-whitespace + trailing
 *     whitespace) per tick. Default. Markdown block boundaries
 *     (newlines between paragraphs) flow through naturally.
 *   - `"line"`: emit one line (run up to and including `\n+`) per tick.
 *     Useful for surfaces where you want to reveal paragraph-by-
 *     paragraph rather than word-by-word.
 *   - `"character"`: emit one character per tick. Closest to a classic
 *     typewriter effect; trades smoothness for higher React render rate
 *     and is best left for very short surfaces.
 */
export type StreamBufferChunking = "word" | "line" | "character";

const CHUNK_REGEXPS: Record<
  Exclude<StreamBufferChunking, "character">,
  RegExp
> = {
  word: /\S+\s+/m,
  line: /[^\n]*\n+/m,
};

/**
 * Time between consecutive emitted chunks. 12ms ≈ 80 chunks/sec — fast
 * enough that a typical LLM (~30 tok/s ≈ 20-30 words/sec) drains the
 * buffer comfortably with a small headroom for occasional provider
 * bursts. Vercel defaults to 10ms; we use 12ms because it reads
 * slightly more deliberate at desktop viewing distance.
 */
const DELAY_MS = 12;

/**
 * Detect the next chunk to emit from the buffer per the chunking mode.
 * Returns the chunk substring (starting at index 0 of `buffer`) or
 * `null` if no complete chunk is available yet.
 */
const detectChunk = (
  buffer: string,
  chunking: StreamBufferChunking,
): string | null => {
  if (chunking === "character") {
    return buffer.length > 0 ? buffer.slice(0, 1) : null;
  }
  const regex = CHUNK_REGEXPS[chunking];
  const match = regex.exec(buffer);
  if (!match) return null;
  // Preserve any non-matching prefix (leading whitespace before the
  // first word match, etc.) so the emitted text never drops content.
  return buffer.slice(0, match.index) + match[0];
};

/**
 * Holds streamed assistant/reasoning text for the active run.
 *
 * Inspired by Vercel AI SDK's `smoothStream`
 * (https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/smooth-stream.ts).
 * Incoming chunks accumulate in an internal buffer; a setTimeout loop
 * emits one complete word every `DELAY_MS` so a bursty provider feed
 * (large coalesced chunk from a network buffer, post-tool-result dump,
 * etc.) gets visually spread into a steady word-by-word reveal instead
 * of teleporting into the DOM. Sparse trickles still emit at the
 * upstream rate — the timer only fires when there's something to drain.
 *
 * Existing semantics preserved:
 *   - `append("")` is a no-op; `append(...)` is fire-and-forget.
 *   - `reset()` clears both buffer and displayed text immediately.
 *   - When `active` flips to true, both clear (mirrors prior "every
 *     new run starts blank" behavior).
 *   - When `active` flips to false, the painter keeps emitting queued
 *     words at the same cadence, then flushes any final partial word
 *     (no trailing whitespace) so the last tokens always surface.
 */
type UseStreamBufferOptions = {
  /**
   * How to split the inbound stream into emit units. Default `"word"`,
   * matching Vercel AI SDK's `smoothStream` default.
   */
  chunking?: StreamBufferChunking;
};

export function useStreamBuffer(
  active: boolean,
  options: UseStreamBufferOptions = {},
): StreamBuffer {
  const chunking = options.chunking ?? "word";
  const [text, setText] = useState("");
  const bufferRef = useRef("");
  const displayedRef = useRef("");
  const timerRef = useRef<number | null>(null);
  const activeRef = useRef(active);
  const chunkingRef = useRef(chunking);
  chunkingRef.current = chunking;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flushAll = useCallback(() => {
    if (bufferRef.current.length === 0) return;
    displayedRef.current = displayedRef.current + bufferRef.current;
    bufferRef.current = "";
    setText(displayedRef.current);
  }, []);

  const tick = useCallback(() => {
    timerRef.current = null;
    const buffer = bufferRef.current;
    if (buffer.length === 0) return;
    const emit = detectChunk(buffer, chunkingRef.current);
    if (emit !== null) {
      bufferRef.current = buffer.slice(emit.length);
      displayedRef.current = displayedRef.current + emit;
      setText(displayedRef.current);
      if (bufferRef.current.length > 0) {
        timerRef.current = window.setTimeout(tick, DELAY_MS);
      }
      return;
    }
    // No complete chunk in buffer (only possible for `word` / `line`
    // chunking when a trailing word/line is missing its terminator).
    //   - Still streaming: wait for more chunks; the next `append()`
    //     reschedules the tick so we resume the moment the terminator
    //     lands.
    //   - Stream ended: flush the trailing partial unit so the user
    //     sees the final tokens immediately rather than swallowing
    //     them behind the chunker's terminator requirement.
    if (!activeRef.current) {
      flushAll();
    }
  }, [flushAll]);

  const ensureTimer = useCallback(() => {
    if (timerRef.current !== null) return;
    if (bufferRef.current.length === 0) return;
    timerRef.current = window.setTimeout(tick, DELAY_MS);
  }, [tick]);

  const append = useCallback(
    (delta: string) => {
      if (!delta) return;
      bufferRef.current = bufferRef.current + delta;
      ensureTimer();
    },
    [ensureTimer],
  );

  const reset = useCallback(() => {
    bufferRef.current = "";
    displayedRef.current = "";
    clearTimer();
    setText("");
  }, [clearTimer]);

  useEffect(() => {
    activeRef.current = active;
    if (active) {
      bufferRef.current = "";
      displayedRef.current = "";
      clearTimer();
      setText("");
    } else {
      // Drain remaining buffered words; tick will detect `active=false`
      // and flush any trailing partial word once no more words match.
      ensureTimer();
    }
  }, [active, clearTimer, ensureTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return { text, append, reset };
}
