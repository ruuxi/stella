import { useCallback, useEffect, useMemo, useState } from "react";
import { storeSidePanelStore } from "../store-side-panel-store";
import { EDIT_BLUEPRINT_PROMPT, type StoreThreadMessage } from "./types";

type UseBlueprintReviewOptions = {
  messages: StoreThreadMessage[];
  /** Mirror of the source-of-truth side-panel store revision so the
   *  blueprint-activation effect re-runs when selections change. */
  panelRevision: unknown;
  appendSyntheticAssistantMessage: (message: StoreThreadMessage) => void;
};

export function useBlueprintReview({
  messages,
  panelRevision,
  appendSyntheticAssistantMessage,
}: UseBlueprintReviewOptions) {
  const [reviewingMessage, setReviewingMessage] =
    useState<StoreThreadMessage | null>(null);
  /**
   * "Edit" mode: the user clicked Edit on a blueprint badge. The
   * composer shows a chip referencing the draft, and the next send
   * passes editingBlueprint=true so the agent's opening message gets
   * the refinement framing.
   */
  const [editingBlueprintId, setEditingBlueprintId] = useState<string | null>(
    null,
  );
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    const activatedMessageId = storeSidePanelStore.consumeBlueprintActivation();
    if (activatedMessageId === undefined) return;
    if (activatedMessageId) {
      setEditingBlueprintId(activatedMessageId);
      return;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (
        msg.role === "assistant" &&
        msg.isBlueprint &&
        !msg.denied &&
        !msg.published
      ) {
        setEditingBlueprintId(msg._id);
        return;
      }
    }
  }, [messages, panelRevision]);

  const editingBlueprintMessage = useMemo(() => {
    if (!editingBlueprintId) return null;
    return messages.find((msg) => msg._id === editingBlueprintId) ?? null;
  }, [editingBlueprintId, messages]);

  const startEditingBlueprint = useCallback(
    (message: StoreThreadMessage) => {
      setEditingBlueprintId(message._id);
      setReviewingMessage(null);
      const syntheticId = `synthetic-edit:${message._id}`;
      appendSyntheticAssistantMessage({
        _id: syntheticId,
        role: "assistant",
        text: EDIT_BLUEPRINT_PROMPT,
      });
    },
    [appendSyntheticAssistantMessage],
  );

  return {
    reviewingMessage,
    setReviewingMessage,
    editingBlueprintId,
    setEditingBlueprintId,
    editingBlueprintMessage,
    publishOpen,
    setPublishOpen,
    startEditingBlueprint,
  };
}
