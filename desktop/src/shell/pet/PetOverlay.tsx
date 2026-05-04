import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Maximize2, MessageSquare, Mic } from "lucide-react";
import type {
  PetAnimationState,
  PetOverlayState,
  PetOverlayStatus,
} from "@/shared/contracts/pet";
import type { VoiceRuntimeSnapshot } from "@/shared/types/electron";
import { DEFAULT_PET_ID } from "./built-in-pets";
import { useSelectedPet } from "./pet-catalog-context";
import { useSelectedPetId } from "./pet-preferences";
import { PetChatPopover } from "./PetChatPopover";
import { PetSprite } from "./PetSprite";
import "./pet-overlay.css";

/** How big the rendered mascot is, in CSS pixels. */
const MASCOT_SIZE = 96;
/** Pointer drag threshold below which a release counts as a click. */
const DRAG_THRESHOLD_PX = 4;
/** Distance from the mascot center where action buttons sit on their arc. */
const ACTION_ARC_RADIUS = 70;
/** Action arc angles (degrees) around the mascot, fanning out to the left.
 *  Three buttons spread between 145° (upper-left) and 215° (lower-left)
 *  with even 35° spacing. */
const ACTION_ANGLES = [145, 180, 215] as const;

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
  const [selectedPetId] = useSelectedPetId(DEFAULT_PET_ID);
  const pet = useSelectedPet(selectedPetId);

  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** Whether the inline chat composer is open. While open, main grows
   *  the pet window leftward to make room and flips `focusable: true`
   *  on so the textarea can take keystrokes. */
  const [chatOpen, setChatOpen] = useState(false);
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
  /** Whether the pet-mic dictation overlay is actively recording.
   *  Broadcast from main as `pet:dictationActive`. Drives the
   *  "Sending to Stella…" status pill that complements the voice
   *  "Listening" pill. */
  const [petDictationActive, setPetDictationActive] = useState(false);

  // Subscribe to the central UI state for `isVoiceRtcActive` (drives
  // the mic button's active red styling) and the voice runtime state
  // for listening / speaking transitions (drive the sprite animation
  // override).
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
    const pet = window.electronAPI?.pet;
    if (pet?.onDictationActive) {
      const off = pet.onDictationActive((active) => {
        setPetDictationActive(active);
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
      // the way that wants clicks (popover, action arc, sprite, bubble,
      // context menu, …) is tagged with `data-pet-hit`.
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

  // The chat popover, context menu, and active drag state must always
  // be interactive regardless of momentary cursor jitter. While any of
  // these are showing we pin the window to interactive so a tiny gap
  // between the dom rects and the cursor never drops the click.
  useEffect(() => {
    if (!open) return;
    if (!chatOpen && !contextMenu && !dragging) return;
    window.electronAPI?.pet?.setInteractive?.(true);
  }, [chatOpen, contextMenu, dragging, open]);

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

  // The mic action button is dictation, not voice. Voice is wake-word
  // gated ("Hey Stella") so the user can't accidentally start a
  // realtime session by clicking. Pressing mic dictates a single
  // utterance which is auto-sent to Stella's chat.
  const handleDictate = useCallback(() => {
    setContextMenu(null);
    setChatOpen(false);
    window.electronAPI?.pet?.requestDictation?.();
  }, []);

  const handleExpand = useCallback(() => {
    setContextMenu(null);
    setChatOpen(false);
    window.electronAPI?.window?.show?.("full");
  }, []);

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
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
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
  const showActions = hover && !dragging;
  const hasBubbleContent =
    Boolean(status.message?.trim()) || Boolean(status.title?.trim());
  // Voice / dictation get a separate Apple-style status pill +
  // sprite halo (see below) — not the chat bubble. The bubble keeps
  // its original role: surfacing agent status messages.
  const showBubble =
    hasBubbleContent && (status.state !== "idle" || assistantBubbleVisible);

  // Status pill mode. Voice listening / speaking takes precedence
  // over dictation (the realtime session can't be active at the
  // same time as a pet-mic dictation overlay anyway). The pill
  // fades out via CSS when `mode === null` so saying "Bye" cleanly
  // dissolves the indicator instead of cutting it.
  type StatusPillMode = "listening" | "speaking" | "dictating";
  const statusPillMode: StatusPillMode | null =
    voiceMode === "speaking"
      ? "speaking"
      : voiceMode === "listening"
        ? "listening"
        : petDictationActive
          ? "dictating"
          : null;
  const statusPillLabel: Record<StatusPillMode, string> = {
    listening: "Listening",
    speaking: "Stella is speaking",
    dictating: "Sending to Stella",
  };

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
        {showBubble && !statusPillMode && (
          <div
            className="pet-overlay-bubble"
            data-visible={showBubble ? "true" : "false"}
            data-pet-hit={showBubble ? "true" : "false"}
          >
            <div className="pet-overlay-bubble-message">{status.message}</div>
          </div>
        )}
        {/* Apple-style voice / dictation status pill. Always mounted
         *  so the fade-out transition runs cleanly when `mode`
         *  flips to null (e.g. user said "Bye"). The corresponding
         *  halo sits behind the sprite. */}
        <div
          className="pet-overlay-status-pill"
          data-mode={statusPillMode ?? "idle"}
          data-visible={statusPillMode ? "true" : "false"}
          aria-hidden={statusPillMode ? "false" : "true"}
        >
          <span
            className="pet-overlay-status-pill__indicator"
            data-mode={statusPillMode ?? "idle"}
          >
            <span className="pet-overlay-status-pill__bar" />
            <span className="pet-overlay-status-pill__bar" />
            <span className="pet-overlay-status-pill__bar" />
          </span>
          <span className="pet-overlay-status-pill__label">
            {statusPillMode ? statusPillLabel[statusPillMode] : ""}
          </span>
        </div>
        <div
          className="pet-overlay-aura"
          data-mode={statusPillMode ?? "idle"}
          data-visible={statusPillMode ? "true" : "false"}
          aria-hidden="true"
        />
        <PetSprite
          spritesheetUrl={pet.spritesheetUrl}
          state={animationState}
          continuous={voiceAnimation != null}
          size={MASCOT_SIZE}
        />
        {(
          [
            {
              key: "dictate",
              label: "Dictate to Stella",
              title: "Dictate",
              icon: <Mic size={16} />,
              onClick: handleDictate,
              active: false,
              angle: ACTION_ANGLES[0],
            },
            {
              key: "chat",
              label: "Send a message",
              title: "Chat",
              icon: <MessageSquare size={16} />,
              onClick: handleChat,
              active: chatOpen,
              angle: ACTION_ANGLES[1],
            },
            {
              key: "expand",
              label: "Open Stella",
              title: "Open Stella",
              icon: <Maximize2 size={16} />,
              onClick: handleExpand,
              active: false,
              angle: ACTION_ANGLES[2],
            },
          ] as const
        ).map(({ key, label, title, icon, onClick, active, angle }) => {
          const radians = (angle * Math.PI) / 180;
          const x = Math.cos(radians) * ACTION_ARC_RADIUS;
          const y = Math.sin(radians) * ACTION_ARC_RADIUS;
          // The chat button stays visible whenever the composer is
          // open so the user can always see the toggle target. The
          // rest of the arc only appears on hover.
          const visible = showActions || (key === "chat" && chatOpen);
          return (
            <button
              key={key}
              type="button"
              className="pet-overlay-action"
              data-visible={visible ? "true" : "false"}
              data-pet-hit={visible ? "true" : "false"}
              data-active={active ? "true" : "false"}
              data-tone={undefined}
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
