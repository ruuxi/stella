import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Camera, Maximize2, MessageSquare } from "lucide-react";
import type {
  PetAnimationState,
  PetOverlayState,
  PetOverlayStatus,
} from "@/shared/contracts/pet";
import {
  BUILT_IN_PETS,
  DEFAULT_PET_ID,
  findBuiltInPet,
} from "./built-in-pets";
import { useSelectedPetId } from "./pet-preferences";
import { PetSprite } from "./PetSprite";
import "./pet-overlay.css";

/** How big the rendered mascot is, in CSS pixels. */
const MASCOT_SIZE = 96;
/** Pointer drag threshold below which a release counts as a click. */
const DRAG_THRESHOLD_PX = 4;
/** Distance from the mascot center where action buttons sit on their arc. */
const ACTION_ARC_RADIUS = 64;
/** Action arc angles (degrees) around the mascot, fanning out to the left. */
const ACTION_ANGLES = [150, 180, 210] as const;

const DEFAULT_PET = findBuiltInPet(DEFAULT_PET_ID) ?? BUILT_IN_PETS[0];

/**
 * Map the high-level mood broadcast by the chat surface to the actual
 * sprite-sheet animation row to play. We deliberately keep this map
 * small and explicit instead of tying the pet to chat internals; this
 * is the only thing the pet needs to know about the orchestrator.
 */
const mapStateToAnimation = (state: PetOverlayState): PetAnimationState => {
  switch (state) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "review":
      return "review";
    case "failed":
      return "failed";
    case "waving":
      return "waving";
    case "idle":
    default:
      return "idle";
  }
};

export type PetOverlayProps = {
  open: boolean;
  status: PetOverlayStatus;
  onClose: () => void;
};

type ContextMenuState = {
  left: number;
  top: number;
};

/**
 * Floating pet companion rendered inside its own dedicated mini
 * `BrowserWindow`.
 *
 * Composition:
 *   - Status bubble (title + latest message + streaming spinner) above
 *     the mascot, mirroring how the working indicator reads in the chat.
 *   - Mascot sprite sheet driven by `mapStateToAnimation(status.state)`.
 *   - Action arc curving around the left side of the sprite — Capture /
 *     Chat / Expand buttons, surfaced on hover so the resting pet stays
 *     clean.
 *   - Right-click context menu with Close pet + Pick another pet.
 *   - Pointer drag to reposition the entire window via the
 *     `pet:moveWindow` IPC.
 *
 * Click-through is automatic: the window's bounds are the hit zone —
 * clicks inside the window go to this component, clicks outside go to
 * whatever app is below. No `setIgnoreMouseEvents` toggling required.
 */
export const PetOverlay = ({
  open,
  status,
  onClose,
}: PetOverlayProps) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [selectedPetId, setSelectedPetId] = useSelectedPetId(DEFAULT_PET.id);
  const pet = findBuiltInPet(selectedPetId) ?? DEFAULT_PET;

  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Drag tracking. We compute the new screen-space window position
  // each pointermove from `event.screenX/Y` minus the offset within
  // the window where the drag started, then send it to main via the
  // `pet:moveWindow` IPC. Main calls `setBounds()` on the dedicated
  // pet `BrowserWindow`.
  const dragStateRef = useRef<{
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      // Don't begin a drag when the pointer started on a button —
      // otherwise quick clicks get swallowed by the drag state machine.
      if (target.closest("button")) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStateRef.current = {
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
      };
      setDragging(true);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.screenX - drag.startScreenX;
      const dy = event.screenY - drag.startScreenY;
      if (
        !drag.moved &&
        Math.abs(dx) < DRAG_THRESHOLD_PX &&
        Math.abs(dy) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      drag.moved = true;
      // The window's current top-left in screen coords is
      // `event.screenX - event.clientX`. To keep the mascot pinned to
      // the cursor, the new window top-left is the cursor's screen
      // position minus the offset within the window where the drag
      // started.
      const newWindowX = event.screenX - drag.startClientX;
      const newWindowY = event.screenY - drag.startClientY;
      window.electronAPI?.pet?.moveWindow?.({
        x: newWindowX,
        y: newWindowY,
      });
    },
    [],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragStateRef.current = null;
      setDragging(false);
      if (drag.moved) {
        // Final commit so any rounding the OS applied is reflected.
        const newWindowX = event.screenX - drag.startClientX;
        const newWindowY = event.screenY - drag.startClientY;
        window.electronAPI?.pet?.moveWindow?.({
          x: newWindowX,
          y: newWindowY,
        });
      }
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* released elsewhere */
      }
    },
    [],
  );

  const handleCapture = useCallback(() => {
    setContextMenu(null);
    void window.electronAPI?.capture?.beginRegionCapture?.();
  }, []);

  const handleChat = useCallback(() => {
    setContextMenu(null);
    window.electronAPI?.pet?.openChat?.();
  }, []);

  const handleExpand = useCallback(() => {
    setContextMenu(null);
    window.electronAPI?.window?.show?.("full");
  }, []);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      setContextMenu({
        left: event.clientX - rect.left,
        top: event.clientY - rect.top,
      });
    },
    [],
  );

  // Click-outside to dismiss the context menu.
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  const handleSelectAnotherPet = useCallback(() => {
    setContextMenu(null);
    // Cycle through built-ins for now; the picker page covers full
    // browsing and the keyboard shortcut keeps the flow snappy from the
    // overlay even when the main window is buried.
    const currentIndex = BUILT_IN_PETS.findIndex(
      (entry) => entry.id === pet.id,
    );
    const next = BUILT_IN_PETS[(currentIndex + 1) % BUILT_IN_PETS.length];
    if (next) {
      setSelectedPetId(next.id);
    }
  }, [pet.id, setSelectedPetId]);

  const handleOpenPicker = useCallback(() => {
    setContextMenu(null);
    window.electronAPI?.window?.show?.("full");
    // The renderer route subscribes to this custom event and navigates.
    window.dispatchEvent(new CustomEvent("stella:pet:open-picker"));
  }, []);

  const handleClosePet = useCallback(() => {
    setContextMenu(null);
    onClose();
    window.electronAPI?.pet?.setOpen?.(false);
  }, [onClose]);

  if (!open) {
    return null;
  }

  // Hover and drag are transient *interaction* animations layered on top
  // of the agent-driven mood. Drag wins (you're physically moving the
  // sprite, that's what the user is doing right now). Hover only wins
  // when the agent is otherwise idle so we don't paper over an active
  // running/waiting/failed state with a wave.
  const baseAnimation = mapStateToAnimation(status.state);
  const animationState: PetAnimationState = dragging
    ? "jumping"
    : hover && baseAnimation === "idle"
      ? "waving"
      : baseAnimation;
  const showActions = hover && !dragging;
  const showBubble =
    Boolean(status.message?.trim()) || Boolean(status.title?.trim());

  return (
    <div
      ref={rootRef}
      className="pet-overlay-root"
      data-dragging={dragging ? "true" : "false"}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {showBubble && (
        <div
          className="pet-overlay-bubble"
          data-visible={hover || status.isLoading ? "true" : "false"}
          data-pet-hit={hover || status.isLoading ? "true" : "false"}
        >
          <div className="pet-overlay-bubble-title">
            {status.isLoading && <span className="pet-overlay-spinner" />}
            <span>{status.title || pet.displayName}</span>
          </div>
          <div className="pet-overlay-bubble-message">{status.message}</div>
        </div>
      )}

      <div
        className="pet-overlay-mascot"
        data-dragging={dragging ? "true" : "false"}
        data-pet-hit="true"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onContextMenu={handleContextMenu}
        title={pet.displayName}
      >
        <PetSprite
          spritesheetUrl={pet.spritesheetUrl}
          state={animationState}
          size={MASCOT_SIZE}
        />
        {(
          [
            {
              key: "capture",
              label: "Capture screenshot",
              title: "Capture",
              icon: <Camera size={14} />,
              onClick: handleCapture,
              angle: ACTION_ANGLES[0],
            },
            {
              key: "chat",
              label: "Open chat",
              title: "Chat",
              icon: <MessageSquare size={14} />,
              onClick: handleChat,
              angle: ACTION_ANGLES[1],
            },
            {
              key: "expand",
              label: "Open Stella",
              title: "Open Stella",
              icon: <Maximize2 size={14} />,
              onClick: handleExpand,
              angle: ACTION_ANGLES[2],
            },
          ] as const
        ).map(({ key, label, title, icon, onClick, angle }) => {
          const radians = (angle * Math.PI) / 180;
          const x = Math.cos(radians) * ACTION_ARC_RADIUS;
          const y = Math.sin(radians) * ACTION_ARC_RADIUS;
          return (
            <button
              key={key}
              type="button"
              className="pet-overlay-action"
              data-visible={showActions ? "true" : "false"}
              data-pet-hit={showActions ? "true" : "false"}
              onClick={onClick}
              aria-label={label}
              title={title}
              style={{
                left: `calc(50% + ${x}px)`,
                top: `calc(50% + ${y}px)`,
              }}
            >
              {icon}
            </button>
          );
        })}
      </div>

      {contextMenu && (
        <div
          className="pet-overlay-context-menu"
          data-pet-hit="true"
          style={{ left: contextMenu.left, top: contextMenu.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="pet-overlay-context-item"
            onClick={handleOpenPicker}
          >
            Pick another pet…
          </button>
          <button
            type="button"
            className="pet-overlay-context-item"
            onClick={handleSelectAnotherPet}
          >
            Cycle next pet
          </button>
          <button
            type="button"
            className="pet-overlay-context-item pet-overlay-context-item-danger"
            onClick={handleClosePet}
          >
            Close pet
          </button>
        </div>
      )}
    </div>
  );
};
