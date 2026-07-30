import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  PetAnimationState,
  PetOverlayState,
  PetOverlayStatus,
} from "@/shared/contracts/pet";
import type { VoiceRuntimeSnapshot } from "@/shared/types/electron";
import { DEFAULT_PET_ID } from "./built-in-pets";
import { useSelectedPet } from "./pet-catalog-context";
import { useSelectedPetId } from "./pet-preferences";
import { PetSprite } from "./PetSprite";
import "./pet-overlay.css";

/** How big the rendered mascot is, in CSS pixels. */
const MASCOT_SIZE = 76;
/** Pointer drag threshold below which a release leaves the pet in place. */
const DRAG_THRESHOLD_PX = 4;

type VoicePetMode = "idle" | "listening" | "speaking";

const VOICE_OUTPUT_LEVEL_THRESHOLD = 0.02;
const ASSISTANT_BUBBLE_VISIBLE_MS = 4_000;

const deriveVoicePetMode = (
  state: VoiceRuntimeSnapshot | null | undefined,
  voiceActive: boolean,
): VoicePetMode => {
  // With wake-word pre-warm the session can be `isConnected: true`
  // even when voice mode is off — connection stays open, mic is
  // gated. Treat the listening / speaking modes as gated on
  // `voiceActive`; only then do connection / level signals matter.
  if (!voiceActive) return "idle";
  if (
    state?.isSpeaking ||
    (state?.outputLevel ?? 0) > VOICE_OUTPUT_LEVEL_THRESHOLD
  ) {
    return "speaking";
  }
  return "listening";
};

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
 * Cross-fade the bubble's inner text whenever the message changes.
 *
 * Two layered slots: at any moment one shows the current message and
 * the other holds the previous message faded to 0. When `message`
 * changes we flip slots, so the new text fades in at the same time
 * the old text fades out — no hot-swap, no width pop (parent bubble
 * has a stable width).
 */
type BubbleSlots = { slots: [string, string]; active: 0 | 1 };

const PetBubbleMessage = ({ message }: { message: string }) => {
  const [{ slots, active }, setBubble] = useState<BubbleSlots>(() => ({
    slots: [message, ""],
    active: 0,
  }));

  if (slots[active] !== message) {
    const nextActive: 0 | 1 = active === 0 ? 1 : 0;
    const nextSlots: [string, string] = [...slots] as [string, string];
    nextSlots[nextActive] = message;
    setBubble({ slots: nextSlots, active: nextActive });
  }

  return (
    <div className="pet-overlay-bubble-message">
      <span
        className="pet-overlay-bubble-message-slot"
        data-active={active === 0 ? "true" : "false"}
      >
        {slots[0]}
      </span>
      <span
        className="pet-overlay-bubble-message-slot"
        data-active={active === 1 ? "true" : "false"}
      >
        {slots[1]}
      </span>
    </div>
  );
};

/**
 * Floating pet companion rendered inside its own dedicated
 * `BrowserWindow`.
 *
 * Composition:
 *   - Status bubble (title + latest message + streaming spinner) above
 *     the mascot, mirroring how the working indicator reads in the chat.
 *   - Mascot sprite sheet driven by `mapStateToAnimation(status.state)`.
 *   - Right-click context menu with Close pet.
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
  const [selectedPetId] = useSelectedPetId(DEFAULT_PET_ID);
  const pet = useSelectedPet(selectedPetId);

  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** Voice (RTC) state. The pet has replaced the standalone voice
   *  creature overlay: when voice is active, the sprite animates
   *  listening / speaking based on the broadcast `voice:runtimeState`,
   *  and the bubble reads "Stella is listening" / "Stella is
   *  speaking". The mic action button is dictation now (voice is
   *  wake-word driven), so we only need to track active state for
   *  the bubble + animation precedence below. */
  const voiceActiveRef = useRef(false);
  const [voiceMode, setVoiceMode] = useState<VoicePetMode>("idle");
  const [assistantBubbleVisible, setAssistantBubbleVisible] = useState(true);

  // Subscribe to the central UI state for `isVoiceRtcActive` and the
  // voice runtime state for listening / speaking transitions, which
  // drive the sprite animation override.
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const applyVoiceActive = (nextActive: boolean) => {
      voiceActiveRef.current = nextActive;
      if (nextActive) {
        setVoiceMode((previous) =>
          previous === "idle" ? "listening" : previous,
        );
      } else {
        setVoiceMode("idle");
      }
    };
    const applyRuntimeState = (
      state: VoiceRuntimeSnapshot | null | undefined,
    ) => {
      setVoiceMode(deriveVoicePetMode(state, voiceActiveRef.current));
    };
    const ui = window.electronAPI?.ui;
    if (ui?.onState) {
      // Initial pull plus subscription so we don't miss the current
      // value if voice was already active when the pet mounted.
      void ui.getState?.().then((state) => {
        applyVoiceActive(Boolean(state?.isVoiceRtcActive));
      });
      const off = ui.onState((state) => {
        applyVoiceActive(Boolean(state?.isVoiceRtcActive));
      });
      if (off) cleanups.push(off);
    }
    const voice = window.electronAPI?.voice;
    if (voice?.onRuntimeState) {
      void voice.getRuntimeState?.().then(applyRuntimeState);
      const off = voice.onRuntimeState(applyRuntimeState);
      if (off) cleanups.push(off);
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  // Mouse-passthrough hit testing. The pet `BrowserWindow` sits with
  // `setIgnoreMouseEvents(true, { forward: true })` by default so the
  // empty pixels around the sprite stop blocking clicks to whatever app
  // is below. We listen to the forwarded mousemove events (they keep
  // arriving even while the window is ignored thanks to `forward:
  // true`) and flip the window into interactive mode whenever the
  // cursor is over a real pixel — `[data-pet-hit="true"]` marks every
  // such element. Outside those rects we drop back to passthrough.
  useEffect(() => {
    if (!open) {
      window.electronAPI?.pet?.setInteractive?.(false);
      return;
    }
    let lastInteractive: boolean | null = null;
    const setInteractive = (next: boolean) => {
      if (lastInteractive === next) return;
      lastInteractive = next;
      window.electronAPI?.pet?.setInteractive?.(next);
    };
    const isInteractiveAtPoint = (clientX: number, clientY: number) => {
      const root = rootRef.current;
      if (!root) return false;
      const ownerDoc = root.ownerDocument ?? document;
      // `elementsFromPoint` walks the stacking order; any element along
      // the way that wants clicks (sprite, bubble, context menu, …) is
      // tagged with `data-pet-hit`.
      const stack = ownerDoc.elementsFromPoint(clientX, clientY);
      for (const node of stack) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.closest("[data-pet-hit=\"true\"]")) return true;
      }
      return false;
    };
    const handleMouseMove = (event: MouseEvent) => {
      setInteractive(isInteractiveAtPoint(event.clientX, event.clientY));
    };
    const handleMouseLeave = () => {
      setInteractive(false);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseleave", handleMouseLeave);
    document.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseleave", handleMouseLeave);
      document.removeEventListener("mouseleave", handleMouseLeave);
      window.electronAPI?.pet?.setInteractive?.(false);
    };
  }, [open]);

  // The context menu and active drag state must always be interactive
  // regardless of momentary cursor jitter. While either is showing we
  // pin the window to interactive so a tiny gap between the dom rects
  // and the cursor never drops the click.
  useEffect(() => {
    if (!open) return;
    if (!contextMenu && !dragging) return;
    window.electronAPI?.pet?.setInteractive?.(true);
  }, [contextMenu, dragging, open]);

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

  const contextMenuRef = useRef<HTMLDivElement | null>(null);

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

  /**
   * Keep the right-click menu inside the pet window. Because the window
   * itself is small, opening the menu near the right or bottom edge
   * would otherwise clip it. We measure the menu after layout and, if
   * it overflows the window's inner box, flip / shift the position so
   * the menu stays fully visible. Padding mirrors the small breathing
   * room around the window's interactive area.
   */
  useLayoutEffect(() => {
    if (!contextMenu) return;
    const node = contextMenuRef.current;
    const root = rootRef.current;
    if (!node || !root) return;
    const margin = 8;
    const rootRect = root.getBoundingClientRect();
    const menuRect = node.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let nextLeft = contextMenu.left;
    let nextTop = contextMenu.top;

    const absoluteRight = rootRect.left + nextLeft + menuRect.width;
    if (absoluteRight > viewportWidth - margin) {
      nextLeft = Math.max(
        margin - rootRect.left,
        nextLeft - menuRect.width,
      );
    }

    const absoluteBottom = rootRect.top + nextTop + menuRect.height;
    if (absoluteBottom > viewportHeight - margin) {
      nextTop = Math.max(
        margin - rootRect.top,
        nextTop - menuRect.height,
      );
    }

    if (nextLeft === contextMenu.left && nextTop === contextMenu.top) return;
    setContextMenu({ left: nextLeft, top: nextTop });
  }, [contextMenu]);

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
    const dismiss = () => setContextMenu(null);
    window.addEventListener("mousedown", handler);
    document.addEventListener("mouseleave", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("mousedown", handler);
      document.removeEventListener("mouseleave", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (status.state !== "idle" || !status.message.trim()) {
      setAssistantBubbleVisible(true);
      return;
    }

    setAssistantBubbleVisible(true);
    const timer = window.setTimeout(() => {
      setAssistantBubbleVisible(false);
    }, ASSISTANT_BUBBLE_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [status.message, status.state]);

  const handleClosePet = useCallback(() => {
    setContextMenu(null);
    onClose();
    window.electronAPI?.pet?.setOpen?.(false);
  }, [onClose]);

  if (!open || !pet) {
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
  const hasBubbleContent =
    Boolean(status.message?.trim()) || Boolean(status.title?.trim());
  const showBubble =
    hasBubbleContent && (status.state !== "idle" || assistantBubbleVisible);

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
        {/* Always mounted so the fade transitions in the CSS run on
         *  every show / hide. The bubble cross-fades its inner message
         *  on text change so message swaps mid-run feel like one
         *  continuous surface instead of a hot-swap. */}
        <div
          className="pet-overlay-bubble"
          data-visible={showBubble ? "true" : "false"}
          data-pet-hit={showBubble ? "true" : "false"}
          aria-hidden={showBubble ? "false" : "true"}
        >
          <PetBubbleMessage message={status.message} />
        </div>
        <PetSprite
          spritesheetUrl={pet.spritesheetUrl}
          state={animationState}
          continuous={voiceAnimation != null}
          size={MASCOT_SIZE}
        />
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="pet-overlay-context-menu"
          data-pet-hit="true"
          style={{ left: contextMenu.left, top: contextMenu.top }}
          onClick={(event) => event.stopPropagation()}
        >
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
