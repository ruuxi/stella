/**
 * Singleton "live display stream" store.
 *
 * The orchestrator's `Display` tool streams partial HTML over the
 * `display:update` IPC channel as the model emits the tool call's
 * `html` argument. Each chunk is the full document so far, not a delta
 * — `runtime/kernel/agent-runtime/display-stream.ts` rebroadcasts
 * roughly every 150ms with whatever has been parsed.
 *
 * The chat surface needs those partials to land directly under the
 * assistant message that's producing them, so canvases morph in place
 * as the model writes them rather than appearing all-at-once at end of
 * turn. Because there is only ever one in-flight Display call per
 * orchestrator turn, a singleton store with `{ html, version }` is
 * enough — no per-row plumbing needed; the most recently mounted /
 * animating `InlineHtmlCanvas` consumes the live html and falls back
 * to its persisted prop once streaming finishes.
 */

import { useSyncExternalStore } from "react";

type Snapshot = {
  html: string;
  /** Monotonic counter so React subscribers see referential change every push. */
  version: number;
};

type Listener = () => void;

const EMPTY: Snapshot = { html: "", version: 0 };

let state: Snapshot = EMPTY;
const listeners = new Set<Listener>();

const emit = (next: Snapshot) => {
  state = next;
  for (const listener of listeners) listener();
};

export const liveDisplayStream = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): Snapshot {
    return state;
  },
  setHtml(html: string): void {
    if (typeof html !== "string") return;
    if (state.html === html) return;
    emit({ html, version: state.version + 1 });
  },
  clear(): void {
    if (state === EMPTY) return;
    emit(EMPTY);
  },
};

export const useLiveDisplayStream = (): Snapshot =>
  useSyncExternalStore(
    liveDisplayStream.subscribe,
    liveDisplayStream.getSnapshot,
    liveDisplayStream.getSnapshot,
  );
