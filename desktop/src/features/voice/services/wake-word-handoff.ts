const WAKE_WORD_HANDOFF_STATE_KEY = "__stellaWakeWordHandoffState";

type WakeWordHandoffListener = (prefill: Promise<string | null>) => void;

type WakeWordHandoffState = {
  pendingPrefill: Promise<string | null> | null;
  listeners: Set<WakeWordHandoffListener>;
};

const getWakeWordHandoffState = (): WakeWordHandoffState => {
  const root = globalThis as typeof globalThis & {
    [WAKE_WORD_HANDOFF_STATE_KEY]?: WakeWordHandoffState;
  };

  if (!root[WAKE_WORD_HANDOFF_STATE_KEY]) {
    root[WAKE_WORD_HANDOFF_STATE_KEY] = {
      pendingPrefill: null,
      listeners: new Set(),
    };
  }

  return root[WAKE_WORD_HANDOFF_STATE_KEY];
};

export function normalizeWakeWordHandoffText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }

  return collapsed
    .replace(/^(?:(?:hey|okay|ok)\s+)?stella(?:[\s,.:;!?-]+|$)/i, "")
    .trim();
}

export function publishWakeWordHandoffPrefill(
  prefill: Promise<string | null>,
): void {
  const state = getWakeWordHandoffState();
  state.pendingPrefill = prefill;
  for (const listener of state.listeners) {
    listener(prefill);
  }
}

export function getPendingWakeWordHandoffPrefill():
  | Promise<string | null>
  | null {
  return getWakeWordHandoffState().pendingPrefill;
}

export function clearWakeWordHandoffPrefill(
  prefill?: Promise<string | null> | null,
): void {
  const state = getWakeWordHandoffState();
  if (!prefill || state.pendingPrefill === prefill) {
    state.pendingPrefill = null;
  }
}

export function subscribeWakeWordHandoffPrefill(
  listener: WakeWordHandoffListener,
): () => void {
  const state = getWakeWordHandoffState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function resetWakeWordHandoffForTests(): void {
  const state = getWakeWordHandoffState();
  state.pendingPrefill = null;
  state.listeners.clear();
}
