import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Camera, Maximize2, MessageSquare, Mic } from "lucide-react";
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
import { PetChatPopover } from "./PetChatPopover";
import { PetSprite } from "./PetSprite";
import "./pet-overlay.css";

/** How big the rendered mascot is, in CSS pixels. */
const MASCOT_SIZE = 96;
/** Pointer drag threshold below which a release counts as a click. */
const DRAG_THRESHOLD_PX = 4;
/** Distance from the mascot center where action buttons sit on their arc. */
const ACTION_ARC_RADIUS = 64;
/** Action arc angles (degrees) around the mascot, fanning out to the left.
 *  Four buttons spread between 135° (upper-left) and 225° (lower-left)
 *  with even ~30° spacing. */
const ACTION_ANGLES = [135, 165, 195, 225] as const;

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
  /** Whether the inline chat composer is open. While open, main grows
   *  the pet window leftward to make room and flips `focusable: true`
   *  on so the textarea can take keystrokes. */
  const [chatOpen, setChatOpen] = useState(false);
  /** Voice (RTC) state. The pet has replaced the standalone voice
   *  creature overlay: when voice is active, the mic action button
   *  turns red and the sprite animates listening / speaking based on
   *  the broadcast `voice:runtimeState`. */
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceMode, setVoiceMode] = useState<"idle" | "listening" | "speaking">(
    "idle",
  );

  // Subscribe to the central UI state for `isVoiceRtcActive` (drives
  // the mic button's active red styling) and the voice runtime state
  // for listening / speaking transitions (drive the sprite animation
  // override).
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const ui = window.electronAPI?.ui;
    if (ui?.onState) {
      // Initial pull plus subscription so we don't miss the current
      // value if voice was already active when the pet mounted.
      void ui.getState?.().then((state) => {
        setVoiceActive(Boolean(state?.isVoiceRtcActive));
      });
      const off = ui.onState((state) => {
        setVoiceActive(Boolean(state?.isVoiceRtcActive));
      });
      if (off) cleanups.push(off);
    }
    const voice = window.electronAPI?.voice;
    if (voice?.onRuntimeState) {
      const off = voice.onRuntimeState((state) => {
        if (!state?.isConnected) {
          setVoiceMode("idle");
          return;
        }
        if (state.isSpeaking) {
          setVoiceMode("speaking");
          return;
        }
        // Connected — sit in the listening pose whenever the AI isn't
        // currently talking. `isUserSpeaking` flickers per VAD frame
        // so we don't gate on it.
        setVoiceMode("listening");
      });
      if (off) cleanups.push(off);
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  // Open / close the composer in two steps so the user never sees a
  // mismatched frame:
  //   - Open:  resize the window first (grows leftward), THEN mount the
  //            popover. If we mounted first, the 380px popover would
  //            render inside the still-280px window and visibly jump
  //            once the resize lands.
  //   - Close: unmount the popover first, THEN shrink the window. If
  //            we shrank first, the popover would briefly render
  //            outside the window's new bounds.
  // The sprite is anchored to the window's right edge in both states,
  // so its absolute screen position never changes across the resize.
  const requestChatOpen = useCallback(() => {
    setContextMenu(null);
    if (chatOpen) {
      // Closing.
      setChatOpen(false);
      window.setTimeout(() => {
        window.electronAPI?.pet?.setComposerActive?.(false);
      }, 16);
      return;
    }
    // Opening.
    window.electronAPI?.pet?.setComposerActive?.(true);
    window.setTimeout(() => {
      setChatOpen(true);
    }, 32);
  }, [chatOpen]);

  // When the pet itself is hidden, force the composer closed too so
  // we never leave main in the wider footprint.
  useEffect(() => {
    if (!open && chatOpen) {
      setChatOpen(false);
      window.electronAPI?.pet?.setComposerActive?.(false);
    }
  }, [open, chatOpen]);

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
    setChatOpen(false);
    void window.electronAPI?.capture?.beginRegionCapture?.();
  }, []);

  // Toggling the chat button opens the inline composer to the LEFT of
  // the sprite — explicitly NOT the full-window sidebar. The popover
  // owns the textarea + auto-focus + submit; submission is one-shot
  // and dismisses the popover (no follow-up window appears).
  const handleChat = useCallback(() => {
    requestChatOpen();
  }, [requestChatOpen]);

  // The popover calls `onSubmit` and then `onDismiss`. We deliberately
  // only close in `onDismiss` so we don't toggle twice and end up
  // re-opening the composer right after a successful send.
  const handleChatSubmit = useCallback((text: string) => {
    window.electronAPI?.pet?.sendMessage?.(text);
  }, []);

  const handleChatDismiss = useCallback(() => {
    if (chatOpen) requestChatOpen();
  }, [chatOpen, requestChatOpen]);

  const handleVoice = useCallback(() => {
    setContextMenu(null);
    setChatOpen(false);
    window.electronAPI?.pet?.requestVoice?.();
  }, []);

  const handleExpand = useCallback(() => {
    setContextMenu(null);
    setChatOpen(false);
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

  // Animation precedence (highest-priority first):
  //   1. Drag — physically moving the sprite, plays "jumping".
  //   2. Voice mode — when realtime voice is active, the sprite stands
  //      in for the (now-removed) voice creature overlay. Speaking →
  //      "waving" (animated, expressive). Listening → "waiting"
  //      (calm, attentive).
  //   3. Hover — only wins on top of an otherwise-idle agent so we
  //      don't paper over running/waiting/failed states with a wave.
  //   4. Otherwise the agent-driven mood (`status.state`).
  const baseAnimation = mapStateToAnimation(status.state);
  const voiceAnimation: PetAnimationState | null =
    voiceMode === "speaking"
      ? "waving"
      : voiceMode === "listening"
        ? "waiting"
        : null;
  const animationState: PetAnimationState = dragging
    ? "jumping"
    : voiceAnimation
      ? voiceAnimation
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
              active: false,
              angle: ACTION_ANGLES[0],
            },
            {
              key: "voice",
              label: voiceActive ? "Stop voice" : "Talk to Stella",
              title: voiceActive ? "Stop voice" : "Voice",
              icon: <Mic size={14} />,
              onClick: handleVoice,
              active: voiceActive,
              angle: ACTION_ANGLES[1],
            },
            {
              key: "chat",
              label: "Send a message",
              title: "Chat",
              icon: <MessageSquare size={14} />,
              onClick: handleChat,
              active: chatOpen,
              angle: ACTION_ANGLES[2],
            },
            {
              key: "expand",
              label: "Open Stella",
              title: "Open Stella",
              icon: <Maximize2 size={14} />,
              onClick: handleExpand,
              active: false,
              angle: ACTION_ANGLES[3],
            },
          ] as const
        ).map(({ key, label, title, icon, onClick, active, angle }) => {
          const radians = (angle * Math.PI) / 180;
          const x = Math.cos(radians) * ACTION_ARC_RADIUS;
          const y = Math.sin(radians) * ACTION_ARC_RADIUS;
          // The chat button stays visible whenever the composer is
          // open and the voice button stays visible whenever voice is
          // active — both so the user can always see the toggle
          // target. The rest of the arc only appears on hover.
          const visible =
            showActions ||
            (key === "chat" && chatOpen) ||
            (key === "voice" && voiceActive);
          return (
            <button
              key={key}
              type="button"
              className="pet-overlay-action"
              data-visible={visible ? "true" : "false"}
              data-pet-hit={visible ? "true" : "false"}
              data-active={active ? "true" : "false"}
              data-tone={key === "voice" && active ? "danger" : undefined}
              onClick={onClick}
              aria-label={label}
              aria-pressed={active}
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
        <PetChatPopover
          open={chatOpen}
          onSubmit={handleChatSubmit}
          onDismiss={handleChatDismiss}
        />
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
