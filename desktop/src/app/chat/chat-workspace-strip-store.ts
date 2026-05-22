import { useSyncExternalStore } from "react";

const STORAGE_KEY_STRIP = "stella.chatWorkspaceStrip.visible";
const STORAGE_KEY_SECTIONS = "stella.chatWorkspaceStrip.sections";

export type WorkspaceStripSection = "activity" | "files" | "schedule";

export type WorkspaceStripSections = Record<WorkspaceStripSection, boolean>;

const DEFAULT_SECTIONS: WorkspaceStripSections = {
  activity: true,
  files: true,
  schedule: true,
};

type Listener = () => void;

type StripStoreSnapshot = {
  stripVisible: boolean;
  sections: WorkspaceStripSections;
};

const safeStorage = (): Storage | null => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

const readPersistedStripVisible = (): boolean => {
  const storage = safeStorage();
  if (!storage) return true;
  return storage.getItem(STORAGE_KEY_STRIP) !== "0";
};

const writePersistedStripVisible = (visible: boolean): void => {
  const storage = safeStorage();
  if (!storage) return;
  storage.setItem(STORAGE_KEY_STRIP, visible ? "1" : "0");
};

const readPersistedSections = (): WorkspaceStripSections => {
  const storage = safeStorage();
  if (!storage) return DEFAULT_SECTIONS;
  try {
    const raw = storage.getItem(STORAGE_KEY_SECTIONS);
    if (!raw) return DEFAULT_SECTIONS;
    const parsed = JSON.parse(raw) as Partial<WorkspaceStripSections>;
    return {
      activity: parsed.activity !== false,
      files: parsed.files !== false,
      schedule: parsed.schedule !== false,
    };
  } catch {
    return DEFAULT_SECTIONS;
  }
};

const writePersistedSections = (sections: WorkspaceStripSections): void => {
  const storage = safeStorage();
  if (!storage) return;
  storage.setItem(STORAGE_KEY_SECTIONS, JSON.stringify(sections));
};

const syncStripHiddenDataset = (visible: boolean): void => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (visible) delete root.dataset.chatWorkspaceStripUserHidden;
  else root.dataset.chatWorkspaceStripUserHidden = "true";
};

let snapshot: StripStoreSnapshot = {
  stripVisible: readPersistedStripVisible(),
  sections: readPersistedSections(),
};
syncStripHiddenDataset(snapshot.stripVisible);

const listeners = new Set<Listener>();

const emit = (next: StripStoreSnapshot) => {
  snapshot = next;
  syncStripHiddenDataset(next.stripVisible);
  for (const listener of listeners) listener();
};

export const chatWorkspaceStripStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): StripStoreSnapshot {
    return snapshot;
  },
  setStripVisible(visible: boolean): void {
    if (snapshot.stripVisible === visible) return;
    writePersistedStripVisible(visible);
    emit({ ...snapshot, stripVisible: visible });
  },
  toggleStripVisible(): void {
    chatWorkspaceStripStore.setStripVisible(!snapshot.stripVisible);
  },
  setSections(sections: WorkspaceStripSections): void {
    if (
      snapshot.sections.activity === sections.activity &&
      snapshot.sections.files === sections.files &&
      snapshot.sections.schedule === sections.schedule
    ) {
      return;
    }
    writePersistedSections(sections);
    emit({ ...snapshot, sections });
  },
  setSectionVisible(section: WorkspaceStripSection, visible: boolean): void {
    if (snapshot.sections[section] === visible) return;
    chatWorkspaceStripStore.setSections({
      ...snapshot.sections,
      [section]: visible,
    });
  },
  toggleSection(section: WorkspaceStripSection): void {
    chatWorkspaceStripStore.setSectionVisible(
      section,
      !snapshot.sections[section],
    );
  },
};

export const useChatWorkspaceStripStore = (): StripStoreSnapshot =>
  useSyncExternalStore(
    chatWorkspaceStripStore.subscribe,
    chatWorkspaceStripStore.getSnapshot,
    chatWorkspaceStripStore.getSnapshot,
  );
