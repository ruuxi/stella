/**
 * StellaContextMenu — right-click toggles the sidebar chat panel.
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

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isComposerContextMenuTarget(e.target)) return;
    e.preventDefault();

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
