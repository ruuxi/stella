import { useEffect, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { api } from "@/convex/api";
import {
  getEmojiGridManifest,
  setEmojiGridManifest,
  subscribeEmojiGridManifest,
  type EmojiGridManifest,
} from "./cells";

type ConvexQueryClient = ReturnType<typeof useConvex>;

let refreshPromise: Promise<void> | null = null;
let refreshComplete = false;

const refreshEmojiGridManifest = (convex: ConvexQueryClient): void => {
  if (refreshComplete || refreshPromise) return;
  refreshPromise = convex
    .query(api.data.emoji_pack_grid.getManifest, {})
    .then((manifest: unknown) => {
      refreshComplete = setEmojiGridManifest(manifest);
    })
    .catch(() => {
      refreshComplete = false;
    })
    .finally(() => {
      refreshPromise = null;
    });
};

export function useEmojiGridManifest(): EmojiGridManifest | null {
  const convex = useConvex();
  const cached = useSyncExternalStore(
    subscribeEmojiGridManifest,
    getEmojiGridManifest,
    getEmojiGridManifest,
  );

  useEffect(() => {
    refreshEmojiGridManifest(convex);
  }, [convex]);

  return cached;
}
