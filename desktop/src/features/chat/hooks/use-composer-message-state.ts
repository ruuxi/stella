/**
 * Composer message state with a companion ref that is synchronized at WRITE
 * time, not render time.
 *
 * Why: the dictate-and-submit flow appends the final transcript via
 * `setMessage(...)` from an async (non-React-event) callback and then fires
 * the send commit on a microtask + requestAnimationFrame. React schedules the
 * corresponding re-render as a normal scheduler (macro)task, and the event
 * loop is allowed to run the rAF callback first whenever a frame deadline
 * lands before that task is dequeued. A ref refreshed in the render body
 * (`ref.current = message`) is therefore still holding the PRE-transcript
 * text when the commit reads it — the send goes out empty (and silently
 * no-ops), while the transcript renders into the composer afterwards and just
 * sits there unsent.
 *
 * Updating the ref synchronously inside the setter makes the send path
 * deterministic: whoever reads `messageRef.current` sees every write that
 * happened before the read, regardless of whether React has rendered yet.
 * All writes must flow through the returned `setMessage` for the ref to stay
 * authoritative.
 */

import { useCallback, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

export const resolveSetStateAction = <T,>(
  action: SetStateAction<T>,
  current: T,
): T =>
  typeof action === "function"
    ? (action as (prev: T) => T)(current)
    : action;

export interface ComposerMessageState {
  message: string;
  /** Drop-in `Dispatch<SetStateAction<string>>`; also syncs `messageRef`. */
  setMessage: Dispatch<SetStateAction<string>>;
  /** Always-current mirror of the message — safe to read from rAF/microtask
   *  callbacks that may run before React flushes the corresponding render. */
  messageRef: MutableRefObject<string>;
}

export function useComposerMessageState(
  initialValue = "",
): ComposerMessageState {
  const [message, setMessageState] = useState(initialValue);
  const messageRef = useRef(message);

  const setMessage = useCallback((action: SetStateAction<string>) => {
    // Resolve functional updaters against the ref (the latest written value)
    // and hand React the resolved string so state and ref can never disagree.
    const next = resolveSetStateAction(action, messageRef.current);
    messageRef.current = next;
    setMessageState(next);
  }, []);

  return { message, setMessage, messageRef };
}
