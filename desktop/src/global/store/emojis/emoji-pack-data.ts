import {
  useAction,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { api } from "@/convex/api";
import type { ActiveEmojiPack } from "@/app/chat/emoji-sprites/active-emoji-pack";

export type EmojiPackVisibility = "public" | "unlisted" | "private";

export type EmojiPackRecord = {
  _id: string;
  _creationTime: number;
  ownerId: string;
  packId: string;
  displayName: string;
  description?: string;
  tags: string[];
  prompt?: string;
  coverEmoji: string;
  coverUrl?: string;
  sheetUrls: string[];
  visibility: EmojiPackVisibility;
  searchText: string;
  authorDisplayName?: string;
  authorHandle?: string;
  installCount?: number;
  createdAt: number;
  updatedAt: number;
};

export const emojiPackToActivePack = (
  pack: Pick<EmojiPackRecord, "packId" | "sheetUrls">,
): ActiveEmojiPack => ({
  packId: pack.packId,
  sheetUrls: pack.sheetUrls,
});

export type EmojiPackSort = "installs" | "name";

export function usePublicEmojiPacks(args?: {
  search?: string;
  sort?: EmojiPackSort;
  tag?: string;
}) {
  const search = args?.search?.trim();
  const tag = args?.tag?.trim();
  return usePaginatedQuery(
    api.data.emoji_packs.listPublicPage,
    {
      ...(search ? { search } : {}),
      ...(args?.sort ? { sort: args.sort } : {}),
      ...(tag ? { tag } : {}),
    },
    { initialNumItems: 32 },
  ) as {
    results: EmojiPackRecord[];
    status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
    loadMore: (numItems: number) => void;
  };
}

export type EmojiPackTagFacet = { tag: string; count: number };

export function useEmojiPackTagFacets() {
  return useQuery(api.data.emoji_packs.listTagFacets, {}) as
    | EmojiPackTagFacet[]
    | undefined;
}

export function useMyEmojiPacks(enabled: boolean) {
  return useQuery(
    api.data.emoji_packs.listMine,
    enabled ? {} : "skip",
  ) as EmojiPackRecord[] | undefined;
}

export function useEmojiPack(packId: string | null) {
  return useQuery(
    api.data.emoji_packs.getByPackId,
    packId ? { packId } : "skip",
  ) as EmojiPackRecord | null | undefined;
}

export function useEmojiPackMutations() {
  return {
    setVisibility: useMutation(api.data.emoji_packs.setVisibility),
    deletePack: useMutation(api.data.emoji_packs.deletePack),
    recordInstall: useMutation(api.data.emoji_packs.recordInstall),
  };
}

export function useGenerateEmojiPack() {
  return useAction(api.data.emoji_pack_generation.generatePack) as (args: {
    prompt: string;
    visibility: EmojiPackVisibility;
  }) => Promise<EmojiPackRecord>;
}
