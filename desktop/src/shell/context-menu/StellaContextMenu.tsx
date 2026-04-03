/**
 * StellaContextMenu — right-click toggles the sidebar chat panel.
 */

import {
  useCallback,
  useRef,
  type ReactNode,
} from "react";

type StellaContextMenuProps = {
  children: ReactNode;
  isSidebarChatOpen: boolean;
  onOpenSidebarChat: () => void;
  onCloseSidebarChat: () => void;
};

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
    } else {
      onOpenRef.current();
    }
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
