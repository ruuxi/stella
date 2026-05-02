/**
 * Composer "+" menu: small persisted ring of recently attached files.
 *
 * Backed by `localStorage` so it survives reloads and is shared across
 * composers in the same renderer (full chat ↔ sidebar). Cross-window
 * propagation rides the standard `storage` event.
 *
 * Files larger than {@link MAX_RECENT_DATA_URL_BYTES} aren't recorded —
 * we don't want a single 15 MB attachment to blow out the localStorage
 * quota and evict everything else.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { ChatContextFile } from "@/shared/types/electron";

const STORAGE_KEY = "stella-composer-recent-files";
const MAX_RECENT_FILES = 3;
/**
 * ~1.5 MB cap per dataUrl. Three slots × 1.5 MB stays well under the
 * conventional ~5 MB localStorage quota; larger attachments still work
 * for the current send, they just don't stick to the recents list.
 */
const MAX_RECENT_DATA_URL_BYTES = 1.5 * 1024 * 1024;

type Listener = () => void;
const subscribers = new Set<Listener>();
let cached: ChatContextFile[] | null = null;

function isValidEntry(value: unknown): value is ChatContextFile {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ChatContextFile>;
  return (
    typeof v.name === "string"
    && typeof v.size === "number"
    && typeof v.mimeType === "string"
    && typeof v.dataUrl === "string"
  );
}

function readStorage(): ChatContextFile[] {
  if (cached) return cached;
  if (typeof localStorage === "undefined") {
    cached = [];
    return cached;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cached = [];
      return cached;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      cached = [];
      return cached;
    }
    cached = parsed
      .filter(isValidEntry)
      .slice(0, MAX_RECENT_FILES);
    return cached;
  } catch {
    cached = [];
    return cached;
  }
}

function writeStorage(next: ChatContextFile[]) {
  cached = next;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota exceeded or storage unavailable — keep the in-memory cache so
      // the current renderer still sees the update; persistence is best-effort.
    }
  }
  for (const fn of subscribers) fn();
}

function entryKey(file: ChatContextFile): string {
  return `${file.name}::${file.size}`;
}

function dedupeAndCap(items: ChatContextFile[]): ChatContextFile[] {
  const seen = new Set<string>();
  const out: ChatContextFile[] = [];
  for (const item of items) {
    const key = entryKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_RECENT_FILES) break;
  }
  return out;
}

function subscribe(onChange: Listener): () => void {
  subscribers.add(onChange);

  // Cross-window propagation: another renderer (e.g. the mini chat
  // window) writing the same key fires a `storage` event here.
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cached = null;
    onChange();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }

  return () => {
    subscribers.delete(onChange);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

const EMPTY: ChatContextFile[] = [];

type UseRecentFilesReturn = {
  recentFiles: ChatContextFile[];
  recordRecentFiles: (files: readonly ChatContextFile[]) => void;
  removeRecentFile: (file: ChatContextFile) => void;
  clearRecentFiles: () => void;
};

export function useRecentFiles(): UseRecentFilesReturn {
  const recentFiles = useSyncExternalStore(
    subscribe,
    readStorage,
    () => EMPTY,
  );

  const recordRecentFiles = useCallback(
    (files: readonly ChatContextFile[]) => {
      if (files.length === 0) return;
      const fresh = files.filter(
        (f) => f.dataUrl.length <= MAX_RECENT_DATA_URL_BYTES,
      );
      if (fresh.length === 0) return;
      writeStorage(dedupeAndCap([...fresh, ...readStorage()]));
    },
    [],
  );

  const removeRecentFile = useCallback((file: ChatContextFile) => {
    const target = entryKey(file);
    writeStorage(readStorage().filter((f) => entryKey(f) !== target));
  }, []);

  const clearRecentFiles = useCallback(() => {
    writeStorage([]);
  }, []);

  return { recentFiles, recordRecentFiles, removeRecentFile, clearRecentFiles };
}
