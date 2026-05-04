import { useCallback, useEffect, useState } from "react";

const PET_OPEN_KEY = "stella:pet:open";
const PET_SELECTED_KEY = "stella:pet:selectedId";
const PET_POSITION_KEY = "stella:pet:position";
const PET_LAST_SEEN_ASSISTANT_MESSAGE_KEY =
  "stella:pet:lastSeenAssistantMessageId";

type PetPosition = { left: number; top: number };

const safeRead = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeWrite = (key: string, value: string): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};

/** Whether the pet should be visible on next overlay mount. */
export const readPetOpenPreference = (): boolean =>
  safeRead(PET_OPEN_KEY) === "1";

export const writePetOpenPreference = (open: boolean): void => {
  safeWrite(PET_OPEN_KEY, open ? "1" : "0");
};

/** Pet ID the user last selected from the picker. */
export const readSelectedPetId = (): string | null => safeRead(PET_SELECTED_KEY);

export const writeSelectedPetId = (id: string): void => {
  safeWrite(PET_SELECTED_KEY, id);
};

/**
 * Hook that mirrors `selectedPetId` across windows.
 *
 * The overlay window and the picker page live in separate React trees
 * (the overlay loads `overlay.html`, the picker loads the main app
 * shell), so they cannot share React state directly. They both subscribe
 * to `storage` events on the same key — when the picker writes, the
 * overlay re-reads instantly without an IPC round-trip.
 */
export const useSelectedPetId = (
  fallback: string,
): [string, (id: string) => void] => {
  const [id, setId] = useState<string>(() => readSelectedPetId() ?? fallback);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: StorageEvent) => {
      if (event.key !== PET_SELECTED_KEY) return;
      setId(event.newValue ?? fallback);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [fallback]);

  const update = useCallback((next: string) => {
    writeSelectedPetId(next);
    setId(next);
  }, []);

  return [id, update];
};

/** Last drag-rest position of the mascot, relative to the overlay window. */
export const readPetPosition = (): PetPosition | null => {
  const raw = safeRead(PET_POSITION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PetPosition>;
    if (
      typeof parsed.left === "number" &&
      typeof parsed.top === "number" &&
      Number.isFinite(parsed.left) &&
      Number.isFinite(parsed.top)
    ) {
      return { left: parsed.left, top: parsed.top };
    }
  } catch {
    /* ignore */
  }
  return null;
};

export const writePetPosition = (position: PetPosition): void => {
  safeWrite(PET_POSITION_KEY, JSON.stringify(position));
};

/** Last assistant message id the pet has already surfaced as an idle bubble. */
export const readLastSeenPetAssistantMessageId = (): string | null =>
  safeRead(PET_LAST_SEEN_ASSISTANT_MESSAGE_KEY);

export const writeLastSeenPetAssistantMessageId = (id: string): void => {
  safeWrite(PET_LAST_SEEN_ASSISTANT_MESSAGE_KEY, id);
};
