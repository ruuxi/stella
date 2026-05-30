/**
 * Store side panel.
 *
 * Three stacked surfaces:
 * 1. Recent changes — rolling-window feature snapshot. Rows toggle
 *    multi-select; one Publish bar below shows how many are selected.
 * 2. Chat thread — optional local messages with the Store agent rendered through
 *    the same `UserMessageRow` / `AssistantMessageRow` components as the
 *    full chat / chat sidebar, so bubble alignment, markdown, and
 *    spacing match across surfaces.
 * 3. Composer — reuses the chat-sidebar shell verbatim
 *    (`.chat-sidebar-composer` / `.chat-sidebar-shell` / etc.) so the
 *    pill, focus glow, and animated submit button match the chat
 *    sidebar.
 *
 * Legacy blueprint drafts render as an `EndResourceCard`-shaped artifact
 * pill inside the assistant row. The primary Publish button now opens the
 * publish form directly for selected source-backed changes.
 *
 * When a new blueprint draft lands while the panel is mounted, fires an
 * OS notification so the user gets pulled back even if the side panel
 * isn't on top.
 */
import { useCallback, useEffect, useState } from "react";
import {
  refreshFeatureSnapshot,
  storeSidePanelStore,
  useStoreSidePanelState,
} from "./store-side-panel-store";
import "@/app/chat/full-shell.chat.css";
import "@/app/chat/compact-conversation.css";
import "@/app/chat/end-resource-card.css";
import "@/app/chat/composer-primitives.css";
import "@/shell/chat-sidebar.css";
import "./store.css";
import { BlueprintDialog } from "./store-side-panel/BlueprintDialog";
import { PublishDialog } from "./store-side-panel/PublishDialog";
import { RecentChangesList } from "./store-side-panel/RecentChangesList";
import { StoreComposer } from "./store-side-panel/StoreComposer";
import { StoreThread } from "./store-side-panel/StoreThread";
import { StoreIllustration } from "@/shell/display/illustrations/StoreIllustration";
import { useBlueprintNotifications } from "./store-side-panel/use-blueprint-notifications";
import { useBlueprintReview } from "./store-side-panel/use-blueprint-review";
import { useStoreThread } from "./store-side-panel/use-store-thread";

export function StoreSidePanel() {
  const state = useStoreSidePanelState();
  const [composer, setComposer] = useState("");
  const [publishSource, setPublishSource] = useState<"selection" | "blueprint">(
    "selection",
  );
  const [publishFeatureNames, setPublishFeatureNames] = useState<string[]>([]);
  const {
    messages,
    sending,
    stopping,
    denying,
    isInFlight,
    latestPublishableBlueprint,
    sendThreadTurn,
    cancelTurn,
    denyLatestBlueprint,
    markBlueprintPublished,
    appendSyntheticAssistantMessage,
  } = useStoreThread();
  const {
    reviewingMessage,
    setReviewingMessage,
    setEditingBlueprintId,
    editingBlueprintMessage,
    publishOpen,
    setPublishOpen,
    startEditingBlueprint,
  } = useBlueprintReview({
    messages,
    panelRevision: state,
    appendSyntheticAssistantMessage,
  });

  useBlueprintNotifications(messages);

  useEffect(() => {
    void refreshFeatureSnapshot();
    return () => {
      storeSidePanelStore.reset();
    };
  }, []);

  const handleSend = useCallback(async () => {
    const text = composer.trim();
    if (!text || sending) return;
    const attachedFeatureNames = Array.from(state.selectedFeatureNames);
    const editingBlueprint = Boolean(editingBlueprintMessage);
    await sendThreadTurn({ text, attachedFeatureNames, editingBlueprint });
    setComposer("");
    setEditingBlueprintId(null);
    storeSidePanelStore.clearSelections();
  }, [
    composer,
    editingBlueprintMessage,
    sending,
    sendThreadTurn,
    setEditingBlueprintId,
    state.selectedFeatureNames,
  ]);

  const handlePublishSelected = useCallback(() => {
    const names = Array.from(state.selectedFeatureNames);
    if (names.length === 0 || sending || isInFlight) return;
    setPublishSource("selection");
    setPublishFeatureNames(names);
    setPublishOpen(true);
  }, [isInFlight, sending, setPublishOpen, state.selectedFeatureNames]);

  const handleApproveBlueprint = useCallback(() => {
    setPublishSource("blueprint");
    setPublishFeatureNames(reviewingMessage?.attachedFeatureNames ?? []);
    setReviewingMessage(null);
    setPublishOpen(true);
  }, [reviewingMessage, setPublishOpen, setReviewingMessage]);

  const handleBlueprintPublished = useCallback(
    async (args: { messageId?: string; releaseNumber: number }) => {
      if (args.messageId) {
        await markBlueprintPublished({
          messageId: args.messageId,
          releaseNumber: args.releaseNumber,
        });
      } else {
        storeSidePanelStore.clearSelections();
      }
      setPublishFeatureNames([]);
      setReviewingMessage(null);
      setPublishOpen(false);
    },
    [markBlueprintPublished, setPublishOpen, setReviewingMessage],
  );

  const handleDenyBlueprint = useCallback(async () => {
    const denied = await denyLatestBlueprint();
    if (denied) {
      setReviewingMessage(null);
    }
  }, [denyLatestBlueprint, setReviewingMessage]);

  return (
    <div
      className="display-sidebar__rich display-sidebar__rich--store store-side-panel"
      data-store-display-tab="store"
    >
      <RecentChangesList
        snapshot={state.snapshot}
        snapshotLoading={state.snapshotLoading}
        selectedFeatureNames={state.selectedFeatureNames}
        publishDisabled={sending || isInFlight}
        onPublishSelected={() => void handlePublishSelected()}
      />

      <StoreThread
        messages={messages}
        onReviewBlueprint={(message) => setReviewingMessage(message)}
        hideEmptyPrompt={(state.snapshot?.items ?? []).length === 0}
      />

      {messages.length === 0 &&
      (state.snapshot?.items ?? []).length === 0 &&
      !state.snapshotLoading ? (
        <div className="store-side-panel-empty-state">
          <div className="store-side-panel-empty-state-art">
            <StoreIllustration />
          </div>
          <p className="store-side-panel-empty-state-body">
            After Stella makes a change for you, publish it to the store from
            here.
          </p>
        </div>
      ) : null}

      <StoreComposer
        composer={composer}
        setComposer={setComposer}
        selectedFeatureNames={state.selectedFeatureNames}
        editingBlueprintMessage={editingBlueprintMessage}
        onClearEditing={() => setEditingBlueprintId(null)}
        sending={sending}
        isInFlight={isInFlight}
        stopping={stopping}
        onSend={() => void handleSend()}
        onStop={() => void cancelTurn()}
      />

      <BlueprintDialog
        open={Boolean(reviewingMessage)}
        message={reviewingMessage}
        canApprove={
          !!latestPublishableBlueprint &&
          !!reviewingMessage &&
          latestPublishableBlueprint._id === reviewingMessage._id
        }
        denying={denying}
        onClose={() => setReviewingMessage(null)}
        onApprove={handleApproveBlueprint}
        onDeny={() => void handleDenyBlueprint()}
        onEdit={() => {
          if (reviewingMessage) startEditingBlueprint(reviewingMessage);
        }}
      />

      <PublishDialog
        open={publishOpen}
        blueprint={
          publishSource === "blueprint" ? latestPublishableBlueprint : null
        }
        selectedFeatureNames={publishFeatureNames}
        onClose={() => {
          setPublishOpen(false);
          setPublishFeatureNames([]);
        }}
        onPublished={handleBlueprintPublished}
      />
    </div>
  );
}
