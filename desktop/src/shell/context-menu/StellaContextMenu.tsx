/**
 * StellaContextMenu — right-click opens the sidebar chat panel.
 *
 * If the right-click target is over meaningful content, captured context
 * is passed to the sidebar so the user can "ask about" what they clicked.
 */

import {
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { ChatContext } from "@/shared/types/electron";
import {
  captureContextAtPoint,
  type CapturedContext,
} from "./context-capture";

type StellaContextMenuProps = {
  children: ReactNode;
  isSidebarChatOpen: boolean;
  onOpenSidebarChat: (chatContext?: ChatContext | null) => void;
  onCloseSidebarChat: () => void;
};

function toSidebarChatContext(captured: CapturedContext): ChatContext {
  return {
    window: {
      app: "Stella",
      title: captured.contextLabel,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    },
    windowText: captured.tightSnapshot,
  };
}

export function StellaContextMenu({
  children,
  isSidebarChatOpen,
  onOpenSidebarChat,
  onCloseSidebarChat,
}: StellaContextMenuProps) {
  const onOpenRef = useRef(onOpenSidebarChat);
  onOpenRef.current = onOpenSidebarChat;
  const onCloseRef = useRef(onCloseSidebarChat);
  onCloseRef.current = onCloseSidebarChat;
  const isOpenRef = useRef(isSidebarChatOpen);
  isOpenRef.current = isSidebarChatOpen;

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();

    if (isOpenRef.current) {
      onCloseRef.current();
      return;
    }

    const target = e.target as Element;
    const captured = captureContextAtPoint(target);
    const hasContent =
      captured.tightSnapshot && captured.tightSnapshot.trim().length > 0;

    onOpenRef.current(hasContent ? toSidebarChatContext(captured) : null);
  }, []);

  return (
    <div
      onContextMenu={handleContextMenu}
      style={{ display: "contents" }}
    >
      {children}
    </div>
  );
}
