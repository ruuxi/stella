/**
 * Right-clicking the main app surface toggles the workspace sidebar.
 * Composer inputs keep their native context menu.
 */

import { useCallback, useRef, type ReactNode } from "react";

type StellaContextMenuProps = {
  children: ReactNode;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
};

export const isComposerContextMenuTarget = (
  target: EventTarget | null,
): boolean =>
  typeof Element !== "undefined" &&
  target instanceof Element &&
  Boolean(target.closest('[data-composer-context-menu="native"]'));

export function StellaContextMenu({
  children,
  isOpen,
  onOpen,
  onClose,
}: StellaContextMenuProps) {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    if (isComposerContextMenuTarget(event.target)) return;
    event.preventDefault();

    if (isOpenRef.current) {
      onCloseRef.current();
    } else {
      onOpenRef.current();
    }
  }, []);

  return (
    <div onContextMenu={handleContextMenu} style={{ display: "contents" }}>
      {children}
    </div>
  );
}
