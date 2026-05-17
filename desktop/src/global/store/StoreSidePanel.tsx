/**
 * Store side panel.
 *
 * Three stacked surfaces:
 * 1. Recent changes — the rolling-window feature snapshot. Each row has
 *    explicit Add (multi-select chip) and Publish (auto-fires a draft
 *    request) actions on the right.
 * 2. Chat thread — local messages with the Store agent rendered through
 *    the same `UserMessageRow` / `AssistantMessageRow` components as the
 *    full chat / chat sidebar, so bubble alignment, markdown, and
 *    spacing match across surfaces. Pending state shows a calm two-line
 *    "Drafting your blueprint." indicator.
 * 3. Composer — reuses the chat-sidebar shell verbatim
 *    (`.chat-sidebar-composer` / `.chat-sidebar-shell` / etc.) so the
 *    pill, focus glow, and animated submit button match the chat
 *    sidebar.
 *
 * Blueprint drafts render as an `EndResourceCard`-shaped artifact pill
 * inside the assistant row, with a right-aligned bordered state badge
 * ("Review required" / "Published" / "Denied"). Clicking opens a glass
 * Radix `Dialog` with the markdown on a solid surface; approving opens
 * a second glass dialog for the publish form.
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

  const handlePublishRow = useCallback(
    async (name: string) => {
      await sendThreadTurn({
        text: `Draft a blueprint to publish: ${name}`,
        attachedFeatureNames: [name],
      });
    },
    [sendThreadTurn],
  );

  const handleApproveBlueprint = useCallback(() => {
    setReviewingMessage(null);
    setPublishOpen(true);
  }, [setPublishOpen, setReviewingMessage]);

  const handleBlueprintPublished = useCallback(
    async (args: { messageId: string; releaseNumber: number }) => {
      await markBlueprintPublished(args);
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
        onPublish={(name) => void handlePublishRow(name)}
      />

      <StoreThread
        messages={messages}
        onReviewBlueprint={(message) => setReviewingMessage(message)}
        hideEmptyPrompt={(state.snapshot?.items ?? []).length === 0}
      />

      {messages.length === 0 && (state.snapshot?.items ?? []).length === 0 && !state.snapshotLoading && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", gap: 12 }}>
          <div style={{ width: 180, height: 135, opacity: 0.9 }}>
            <StoreIllustration />
          </div>
          <div className="store-side-panel-empty" style={{ maxWidth: 240, fontSize: 15 }}>
            After Stella makes a change for you, publish it to the store from
            here.
          </div>
        </div>
      )}

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
        blueprint={latestPublishableBlueprint}
        onClose={() => setPublishOpen(false)}
        onPublished={handleBlueprintPublished}
      />
    </div>
  );
}
