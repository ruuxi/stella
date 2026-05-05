import { useSyncExternalStore } from "react";
import type { MediaAsset } from "@/shared/contracts/display-payload";

export type MediaPreviewDialogPayload = {
  asset: MediaAsset;
  prompt?: string;
  capability?: string;
  initialIndex?: number;
};

type Snapshot = {
  payload: MediaPreviewDialogPayload | null;
};

const EMPTY: Snapshot = { payload: null };
let state: Snapshot = EMPTY;
const listeners = new Set<() => void>();

const emit = (next: Snapshot) => {
  state = next;
  for (const listener of listeners) listener();
};

export const mediaPreviewDialog = {
  open(payload: MediaPreviewDialogPayload): void {
    emit({ payload });
  },
  close(): void {
    emit(EMPTY);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): Snapshot {
    return state;
  },
};

export const useMediaPreviewDialog = (): Snapshot =>
  useSyncExternalStore(
    mediaPreviewDialog.subscribe,
    mediaPreviewDialog.getSnapshot,
    mediaPreviewDialog.getSnapshot,
  );
