/**
 * Read-aloud player — single-instance audio playback for the
 * "read finalized assistant replies" toggle.
 *
 * Owns one AudioContext and at most one in-flight buffer source:
 *   - `play(buffer)` cancels any current playback and starts the new
 *     one immediately so a fresh assistant turn never overlaps with the
 *     previous one's audio.
 *   - `stop()` cancels playback without queuing anything new.
 *   - `dispose()` tears the AudioContext down.
 *
 * Decoding is provider-agnostic (delegates to `decodeAudioData`), so
 * the same player handles OpenAI mp3, Inworld wav, etc.
 */

let context: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

const getContext = (): AudioContext => {
  if (context && context.state !== "closed") return context;
  context = new AudioContext();
  return context;
};

const stopCurrent = () => {
  if (!currentSource) return;
  try {
    currentSource.onended = null;
    currentSource.stop();
  } catch {
    /* already stopped */
  }
  try {
    currentSource.disconnect();
  } catch {
    /* already disconnected */
  }
  currentSource = null;
};

export type PlayOptions = {
  /** Called once playback ends naturally (not when interrupted by a new `play`). */
  onEnded?: () => void;
};

/**
 * Decode and play an encoded audio buffer. Resolves once playback has
 * begun; the optional `onEnded` callback fires at natural completion.
 */
export async function playReadAloud(
  encoded: ArrayBuffer,
  options: PlayOptions = {},
): Promise<void> {
  const ctx = getContext();
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => undefined);
  }

  // decodeAudioData detaches the buffer in newer browsers, so clone
  // once defensively to keep the input usable for callers that retain
  // a reference.
  const decoded = await ctx.decodeAudioData(encoded.slice(0));

  stopCurrent();

  const source = ctx.createBufferSource();
  source.buffer = decoded;
  source.connect(ctx.destination);

  // Capture this source so a subsequent `play()` only nulls ours if
  // we're still the active node.
  const thisSource = source;
  source.onended = () => {
    if (currentSource === thisSource) {
      currentSource = null;
    }
    options.onEnded?.();
  };

  currentSource = source;
  source.start();
}

export function stopReadAloud(): void {
  stopCurrent();
}

export function disposeReadAloud(): void {
  stopCurrent();
  if (context) {
    context.close().catch(() => undefined);
    context = null;
  }
}

export function isReadAloudPlaying(): boolean {
  return currentSource !== null;
}
