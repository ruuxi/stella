import { useCallback, useEffect, useState } from "react";
import { BUNDLED_PETS } from "@/shell/pet/bundled-pets";

const STORAGE_KEY = "stella:pet:installed";

/**
 * Pet IDs the user has explicitly added to their library. Bundled pets
 * are always considered installed; user-created pets the current user
 * owns are always installed (handled at the call site since it depends
 * on Convex `listMine`).
 */
const safeRead = (): Set<string> => {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === "string"));
    }
  } catch {
    /* ignore */
  }
  return new Set();
};

const safeWrite = (set: Set<string>): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Array.from(set)),
    );
  } catch {
    /* ignore */
  }
};

export const isBundledPetId = (petId: string): boolean =>
  BUNDLED_PETS.some((pet) => pet.id === petId);

const CHANGE_EVENT = "stella:pet-installs:changed";

const dispatchChange = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

export const readInstalledPetIds = (): Set<string> => safeRead();

export const addInstalledPet = (petId: string): void => {
  const next = safeRead();
  if (next.has(petId)) return;
  next.add(petId);
  safeWrite(next);
  dispatchChange();
};

export const removeInstalledPet = (petId: string): void => {
  const next = safeRead();
  if (!next.delete(petId)) return;
  safeWrite(next);
  dispatchChange();
};

/**
 * Subscribe-able view of the install set. Updates immediately within
 * the same window and across windows via the storage event so multiple
 * Pets app instances stay in sync.
 */
export const useInstalledPets = (): {
  installed: Set<string>;
  isInstalled: (petId: string) => boolean;
  install: (petId: string) => void;
  uninstall: (petId: string) => void;
} => {
  const [installed, setInstalled] = useState<Set<string>>(() => safeRead());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = () => setInstalled(safeRead());
    const storageHandler = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) refresh();
    };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", storageHandler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", storageHandler);
    };
  }, []);

  const isInstalled = useCallback(
    (petId: string) => isBundledPetId(petId) || installed.has(petId),
    [installed],
  );

  return {
    installed,
    isInstalled,
    install: addInstalledPet,
    uninstall: removeInstalledPet,
  };
};
