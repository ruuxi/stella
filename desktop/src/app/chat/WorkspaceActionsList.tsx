import { useCallback, useEffect, useState } from "react";
import { MessageSquarePlus, Scan } from "lucide-react";
import { CustomDevice as Device } from "@/ui/nav-icons";
import { openConnectDialog } from "@/global/integrations/connect-action";
import { preloadConnectDialog } from "@/shell/topbar/nav-surface-preloads";
import { showToast } from "@/ui/toast";
import "./workspace-actions-list.css";

const NEW_CHAT_CONFIRM_TIMEOUT_MS = 3000;

type WorkspaceActionsListProps = {
  onNewChat?: () => void | Promise<void>;
  onSelectArea?: () => void;
};

export function WorkspaceActionsList({
  onNewChat,
  onSelectArea,
}: WorkspaceActionsListProps) {
  const [newChatArmed, setNewChatArmed] = useState(false);
  const [newChatPending, setNewChatPending] = useState(false);

  const handleConnect = useCallback(() => {
    setNewChatArmed(false);
    preloadConnectDialog();
    openConnectDialog();
  }, []);

  const handleNewChat = useCallback(async () => {
    if (!onNewChat || newChatPending) return;
    if (!newChatArmed) {
      setNewChatArmed(true);
      return;
    }
    setNewChatPending(true);
    try {
      await onNewChat();
      setNewChatArmed(false);
    } catch (error) {
      console.warn("[workspace-actions] new chat failed:", error);
      showToast({
        title: "Couldn’t start a new chat",
        description:
          error instanceof Error && error.message
            ? error.message
            : "Stella will keep this chat open.",
        variant: "error",
      });
    } finally {
      setNewChatPending(false);
    }
  }, [newChatArmed, newChatPending, onNewChat]);

  useEffect(() => {
    if (!newChatArmed || newChatPending) return;
    const timeout = window.setTimeout(() => {
      setNewChatArmed(false);
    }, NEW_CHAT_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [newChatArmed, newChatPending]);

  const handleSelectArea = useCallback(() => {
    setNewChatArmed(false);
    onSelectArea?.();
  }, [onSelectArea]);

  return (
    <ul className="workspace-actions-list">
      <li className="workspace-actions-list__item">
        <button
          type="button"
          className="workspace-actions-list__row"
          onClick={handleConnect}
          onMouseEnter={preloadConnectDialog}
          onFocus={preloadConnectDialog}
        >
          <span className="workspace-actions-list__icon" aria-hidden="true">
            <Device size={14} />
          </span>
          <span className="workspace-actions-list__label">Connect</span>
        </button>
      </li>
      {onNewChat ? (
        <li className="workspace-actions-list__item">
          <button
            type="button"
            className="workspace-actions-list__row"
            onClick={() => {
              void handleNewChat();
            }}
            disabled={newChatPending}
          >
            <span className="workspace-actions-list__icon" aria-hidden="true">
              <MessageSquarePlus size={14} strokeWidth={1.85} />
            </span>
            <span className="workspace-actions-list__label">
              {newChatArmed ? "Confirm new chat" : "New chat"}
            </span>
          </button>
        </li>
      ) : null}
      {onSelectArea ? (
        <li className="workspace-actions-list__item">
          <button
            type="button"
            className="workspace-actions-list__row"
            onClick={handleSelectArea}
          >
            <span className="workspace-actions-list__icon" aria-hidden="true">
              <Scan size={14} strokeWidth={1.85} />
            </span>
            <span className="workspace-actions-list__label">Select area</span>
          </button>
        </li>
      ) : null}
    </ul>
  );
}
