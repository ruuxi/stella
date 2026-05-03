import { normalizePet, type BuiltInPet } from "./built-in-pets";

/** First-page list cache used by the Pets app for instant cold start. */
const PET_CATALOG_FIRST_PAGE_KEY = "stella:pet:catalog:firstPage";
/** Map of `petId → pet` cached by the overlay so the floating mascot can
 *  render synchronously across reloads even when offline. */
const PET_BY_ID_KEY = "stella:pet:byId";
/** Hard cap on cached entries so a long session can't grow this map
 *  without bound. Eviction is "drop the oldest insertion". */
const PET_BY_ID_CAPACITY = 32;

type CachedFirstPage = {
  pets: Array<Partial<BuiltInPet>>;
};

type CachedPetMap = {
  /** Insertion order, oldest first. Used purely for FIFO eviction; the
   *  authoritative pet record lives in `entries`. */
  order: string[];
  entries: Record<string, Partial<BuiltInPet>>;
};

const safeRead = <T>(key: string): T | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const safeWrite = (key: string, value: unknown): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* cache is best-effort */
  }
};

export const getCachedPetCatalogFirstPage = (): BuiltInPet[] => {
  const cached = safeRead<CachedFirstPage>(PET_CATALOG_FIRST_PAGE_KEY);
  if (!cached || !Array.isArray(cached.pets)) return [];
  return cached.pets
    .map(normalizePet)
    .filter((pet): pet is BuiltInPet => pet !== null);
};

export const writeCachedPetCatalogFirstPage = (pets: BuiltInPet[]): void => {
  safeWrite(PET_CATALOG_FIRST_PAGE_KEY, { pets });
};

const readCachedPetMap = (): CachedPetMap => {
  const cached = safeRead<CachedPetMap>(PET_BY_ID_KEY);
  if (!cached || !Array.isArray(cached.order) || !cached.entries) {
    return { order: [], entries: {} };
  }
  return cached;
};

export const getCachedPetById = (id: string): BuiltInPet | null => {
  const map = readCachedPetMap();
  const raw = map.entries[id];
  if (!raw) return null;
  return normalizePet(raw);
};

export const writeCachedPetById = (pet: BuiltInPet): void => {
  const map = readCachedPetMap();
  if (map.entries[pet.id]) {
    map.entries[pet.id] = pet;
  } else {
    map.order.push(pet.id);
    map.entries[pet.id] = pet;
    while (map.order.length > PET_BY_ID_CAPACITY) {
      const evicted = map.order.shift();
      if (evicted) delete map.entries[evicted];
    }
  }
  safeWrite(PET_BY_ID_KEY, map);
};

export const PET_CATALOG_FIRST_PAGE_STORAGE_KEY = PET_CATALOG_FIRST_PAGE_KEY;
export const PET_BY_ID_STORAGE_KEY = PET_BY_ID_KEY;
