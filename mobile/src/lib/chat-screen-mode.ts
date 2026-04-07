export type ChatScreenMode = "chat" | "computer";

type Listener = (mode: ChatScreenMode) => void;

let currentMode: ChatScreenMode = "chat";
const listeners = new Set<Listener>();

export function getChatScreenMode(): ChatScreenMode {
  return currentMode;
}

export function setChatScreenMode(next: ChatScreenMode) {
  if (next === currentMode) return;
  currentMode = next;
  for (const fn of listeners) fn(next);
}

export function subscribeChatScreenMode(fn: Listener): () => void {
  listeners.add(fn);
  fn(currentMode);
  return () => listeners.delete(fn);
}
