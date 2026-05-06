export type EmojiGridManifest = {
  version: string;
  gridSize: number;
  sheets: string[][];
};

const CACHE_KEY = "stella-emoji-grid-manifest";

let activeManifest: EmojiGridManifest | null = null;
const listeners = new Set<() => void>();

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const normalizeEmojiGridManifest = (
  value: unknown,
): EmojiGridManifest | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as {
    version?: unknown;
    gridSize?: unknown;
    sheets?: unknown;
  };
  if (typeof record.version !== "string" || record.version.length === 0) {
    return null;
  }
  if (
    typeof record.gridSize !== "number" ||
    !Number.isInteger(record.gridSize) ||
    record.gridSize <= 0
  ) {
    return null;
  }
  if (
    !Array.isArray(record.sheets) ||
    record.sheets.length === 0 ||
    !record.sheets.every(isStringArray)
  ) {
    return null;
  }
  const expectedCells = record.gridSize * record.gridSize;
  if (!record.sheets.every((sheet) => sheet.length === expectedCells)) {
    return null;
  }
  return {
    version: record.version,
    gridSize: record.gridSize,
    sheets: record.sheets.map((sheet) => [...sheet]),
  };
};

const readStoredManifest = (): EmojiGridManifest | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return normalizeEmojiGridManifest(JSON.parse(raw));
  } catch {
    return null;
  }
};

const writeStoredManifest = (manifest: EmojiGridManifest): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(manifest));
  } catch {
    // localStorage is best-effort; the in-memory manifest still updates.
  }
};

activeManifest = readStoredManifest();

export const getEmojiGridManifest = (): EmojiGridManifest | null =>
  activeManifest;

export const setEmojiGridManifest = (value: unknown): boolean => {
  const next = normalizeEmojiGridManifest(value);
  if (!next) return false;
  const previous = activeManifest;
  if (
    previous &&
    previous.version === next.version &&
    previous.gridSize === next.gridSize
  ) {
    return true;
  }
  activeManifest = next;
  writeStoredManifest(next);
  listeners.forEach((listener) => listener());
  return true;
};

export const subscribeEmojiGridManifest = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getEmojiSheets = (): string[][] =>
  activeManifest?.sheets ?? [];

export const getEmojiSheetGridSize = (): number =>
  activeManifest?.gridSize ?? 0;

export const getEmojiSheetCellCount = (): number => {
  const size = getEmojiSheetGridSize();
  return size * size;
};

