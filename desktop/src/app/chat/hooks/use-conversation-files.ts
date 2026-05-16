/**
 * Hook over the file-events stream for a conversation
 * (`localChat:listFiles` IPC, backed by `SessionStore.listFiles`).
 * Returns the raw file-carrying events (`tool_result` /
 * `agent-completed` with non-empty `fileChanges` / `producedFiles`);
 * `deriveConversationFiles` further dedupes them by path.
 *
 * Window growth is purely file-event-count based. File events are even
 * sparser than activity events (only fire when a tool actually
 * touches disk), so a cap of 500 covers everyday usage and
 * `loadOlder` doubles the window for the ActivityHistoryDialog
 * "files" section.
 */
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useChatStore } from "@/context/chat-store";
import {
  subscribeToLocalFilesWindow,
  type LocalFilesWindowSnapshot,
} from "@/app/chat/services/local-files-store";
import { showToast } from "@/ui/toast";
import type { EventRecord } from "../../../../../runtime/contracts/local-chat.js";

export const FILES_PAGE_SIZE = 500;
const LOCAL_FILES_LOAD_RETRY_MS = 300;

const EMPTY_FILES: EventRecord[] = [];

const EMPTY_SNAPSHOT: LocalFilesWindowSnapshot = {
  window: { files: EMPTY_FILES },
  hasLoaded: false,
  error: null,
};

export type ConversationFilesFeed = {
  files: EventRecord[];
  hasOlderFiles: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
  loadOlder: () => void;
};

export const useConversationFiles = (
  conversationId?: string,
): ConversationFilesFeed => {
  const { storageMode } = useChatStore();
  const isLocalMode = storageMode === "local";

  const visitKey = `${storageMode}:${conversationId ?? ""}`;
  const visitToken = useMemo(() => Symbol(visitKey), [visitKey]);

  const [limit, setLimit] = useState(FILES_PAGE_SIZE);
  const [pendingLimit, setPendingLimit] = useState<number | null>(null);

  useEffect(() => {
    setLimit(FILES_PAGE_SIZE);
    setPendingLimit(null);
  }, [visitToken]);

  const [snapshotState, setSnapshotState] = useState<{
    visitToken: symbol;
    snapshot: LocalFilesWindowSnapshot;
  }>({
    visitToken,
    snapshot: EMPTY_SNAPSHOT,
  });
  const lastLocalLoadToastAtRef = useRef(0);
  const [localRetryTick, setLocalRetryTick] = useState(0);

  useEffect(() => {
    setSnapshotState({ visitToken, snapshot: EMPTY_SNAPSHOT });
  }, [visitToken]);

  useEffect(() => {
    if (!isLocalMode || !conversationId) {
      setSnapshotState({
        visitToken,
        snapshot: {
          window: { files: EMPTY_FILES },
          hasLoaded: true,
          error: null,
        },
      });
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    const scheduleRetry = () => {
      if (cancelled || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!cancelled) {
          setLocalRetryTick((current) => current + 1);
        }
      }, LOCAL_FILES_LOAD_RETRY_MS);
    };
    const unsubscribe = subscribeToLocalFilesWindow(
      { conversationId, limit },
      (snapshot) => {
        if (cancelled) return;
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
        setSnapshotState({ visitToken, snapshot });
        if (!snapshot.error) return;
        const now = Date.now();
        if (now - lastLocalLoadToastAtRef.current > 10_000) {
          lastLocalLoadToastAtRef.current = now;
          showToast({
            title: "Couldn’t load file history",
            description:
              snapshot.error.message || "Stella will retry in a moment.",
            variant: "error",
          });
        }
        scheduleRetry();
      },
    );
    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      unsubscribe();
    };
  }, [conversationId, isLocalMode, limit, localRetryTick, visitToken]);

  const activeSnapshot =
    snapshotState.visitToken === visitToken
      ? snapshotState.snapshot
      : EMPTY_SNAPSHOT;

  const files = activeSnapshot.window.files;

  const hasOlderFiles =
    activeSnapshot.hasLoaded && files.length >= limit;

  const isLoadingOlder =
    pendingLimit !== null && files.length < pendingLimit;

  useEffect(() => {
    if (pendingLimit === null) return;
    if (files.length >= pendingLimit) {
      setPendingLimit(null);
      return;
    }
    if (activeSnapshot.hasLoaded && !hasOlderFiles) {
      setPendingLimit(null);
    }
  }, [
    activeSnapshot.hasLoaded,
    files.length,
    hasOlderFiles,
    pendingLimit,
  ]);

  const loadOlder = useCallback(() => {
    if (!conversationId || !isLocalMode) return;
    if (!hasOlderFiles) return;
    if (pendingLimit !== null) return;
    const next = limit + FILES_PAGE_SIZE;
    setPendingLimit(next);
    startTransition(() => {
      setLimit(next);
    });
  }, [conversationId, hasOlderFiles, isLocalMode, limit, pendingLimit]);

  const isInitialLoading =
    Boolean(conversationId) &&
    isLocalMode &&
    !activeSnapshot.hasLoaded &&
    files.length === 0;

  return {
    files,
    hasOlderFiles,
    isLoadingOlder,
    isInitialLoading,
    loadOlder,
  };
};
