import { useCallback, useEffect, useState } from "react";

const ACTIVE_EMOJI_PACK_KEY = "stella:emoji-pack:active";

export type ActiveEmojiPack = {
  packId: string;
  sheet1Url: string;
  sheet2Url: string;
};

const isActiveEmojiPack = (value: unknown): value is ActiveEmojiPack => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.packId === "string" &&
    record.packId.trim().length > 0 &&
    typeof record.sheet1Url === "string" &&
    record.sheet1Url.trim().length > 0 &&
    typeof record.sheet2Url === "string" &&
    record.sheet2Url.trim().length > 0
  );
};

export const readActiveEmojiPack = (): ActiveEmojiPack | null => {
  try {
    const raw = window.localStorage.getItem(ACTIVE_EMOJI_PACK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isActiveEmojiPack(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeActiveEmojiPack = (pack: ActiveEmojiPack | null): void => {
  if (pack) {
    window.localStorage.setItem(ACTIVE_EMOJI_PACK_KEY, JSON.stringify(pack));
  } else {
    window.localStorage.removeItem(ACTIVE_EMOJI_PACK_KEY);
  }
  window.dispatchEvent(new Event("stella-active-emoji-pack-change"));
};

export const useActiveEmojiPack = (): [
  ActiveEmojiPack | null,
  (pack: ActiveEmojiPack | null) => void,
] => {
  const [pack, setPack] = useState<ActiveEmojiPack | null>(() =>
    readActiveEmojiPack(),
  );
  useEffect(() => {
    const sync = () => setPack(readActiveEmojiPack());
    const onStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_EMOJI_PACK_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("stella-active-emoji-pack-change", sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("stella-active-emoji-pack-change", sync);
    };
  }, []);
  const update = useCallback((next: ActiveEmojiPack | null) => {
    writeActiveEmojiPack(next);
    setPack(next);
  }, []);
  return [pack, update];
};
