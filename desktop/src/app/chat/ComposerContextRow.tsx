import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { getElectronApi } from "@/platform/electron/electron";
import {
  InlineWorkingIndicator,
  type InlineWorkingIndicatorMountProps,
} from "./InlineWorkingIndicator";
import {
  ComposerCaptureContextSection,
  ComposerFileContextSection,
  ComposerSelectedTextContextSection,
  ComposerWindowContextSection,
} from "./ComposerContextSections";
import {
  appChipToChatContext,
  tabChipToChatContext,
  useAutoContextChips,
  type RecentAppChip,
  type BrowserTabChip,
  type SuggestionChip,
  type SuggestionLane,
  type SuggestionSlot,
} from "./hooks/use-auto-context-chips";
import { truncateChipLabel } from "./composer-context";

// ---------------------------------------------------------------------------
// Attached chips — context the user has committed to sending. Lives INSIDE
// the composer shell as a row above the textarea.
// ---------------------------------------------------------------------------

type ComposerContextRowProps = {
  variant?: "full" | "mini";
  chatContext: ChatContext | null;
  selectedText: string | null;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  setSelectedText: Dispatch<SetStateAction<string | null>>;
  onPreviewScreenshot?: (index: number) => void;
};

export function ComposerContextRow({
  variant = "full",
  chatContext,
  selectedText,
  setChatContext,
  setSelectedText,
  onPreviewScreenshot,
}: ComposerContextRowProps) {
  return (
    <div className="composer-context-actions">
      <ComposerCaptureContextSection
        variant={variant}
        chatContext={chatContext}
        setChatContext={setChatContext}
        onPreviewScreenshot={onPreviewScreenshot}
      />
      <ComposerFileContextSection
        variant={variant}
        chatContext={chatContext}
        setChatContext={setChatContext}
      />
      <ComposerSelectedTextContextSection
        variant={variant}
        selectedText={selectedText}
        setSelectedText={setSelectedText}
        setChatContext={setChatContext}
      />
      <ComposerWindowContextSection
        variant={variant}
        chatContext={chatContext}
        setChatContext={setChatContext}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggestion chips — auto-detected context Stella offers but hasn't yet
// attached. Rendered floating ABOVE the composer shell (the panel chat
// opts into this; the full-shell composer doesn't use it today).
// ---------------------------------------------------------------------------

type ComposerSuggestionRowProps = {
  chatContext: ChatContext | null;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  indicator?: InlineWorkingIndicatorMountProps;
};

export function ComposerSuggestionContextRow({
  chatContext,
  setChatContext,
  indicator,
}: ComposerSuggestionRowProps) {
  const { lanes, dismissSlot } = useAutoContextChips(true);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [hiddenLaneIndexes, setHiddenLaneIndexes] = useState<Set<number>>(
    () => new Set(),
  );

  // Hide a chip whose contents match the currently-attached context (we
  // don't want "+ Brave – github.com" suggesting itself when it's already
  // attached). The lane stays mounted so the row's reserved height is kept
  // — only the chip body is omitted.
  const attachedAppName =
    chatContext?.window?.app?.toLowerCase().trim() ?? null;
  const attachedUrl = chatContext?.browserUrl ?? null;

  const isChipAttached = (chip: SuggestionChip): boolean => {
    if (chip.kind === "tab") {
      return Boolean(attachedUrl && attachedUrl === chip.url);
    }
    return Boolean(
      attachedAppName && chip.name.toLowerCase().trim() === attachedAppName,
    );
  };

  const laneVisibilityKey = useMemo(
    () =>
      lanes
        .map((lane) => {
          const current =
            lane.current && !isChipAttached(lane.current.chip)
              ? `${lane.current.key}:${lane.current.phase}`
              : "";
          const outgoing = lane.outgoing
            ? `${lane.outgoing.key}:${lane.outgoing.phase}`
            : "";
          return `${current}|${outgoing}`;
        })
        .join(","),
    [lanes, attachedAppName, attachedUrl],
  );

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    let frame = 0;

    const syncVisibleLanes = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const laneEls = Array.from(
          row.querySelectorAll<HTMLElement>(
            ".composer-context-suggestion-lane",
          ),
        );
        const availableWidth = row.clientWidth;
        const styles = window.getComputedStyle(row);
        const gap =
          Number.parseFloat(styles.columnGap || styles.gap || "0") || 0;
        const nextHidden = new Set<number>();
        let usedWidth = 0;
        let visibleCount = 0;

        for (const laneEl of laneEls) {
          const rawIndex = laneEl.dataset.laneIndex;
          const laneIndex = rawIndex ? Number.parseInt(rawIndex, 10) : NaN;
          if (!Number.isFinite(laneIndex)) continue;

          const laneWidth = laneEl.offsetWidth;
          if (laneWidth <= 0) continue;

          const nextWidth =
            usedWidth + (visibleCount > 0 ? gap : 0) + laneWidth;
          if (nextWidth <= availableWidth) {
            usedWidth = nextWidth;
            visibleCount += 1;
          } else {
            nextHidden.add(laneIndex);
          }
        }

        setHiddenLaneIndexes((current) => {
          if (current.size === nextHidden.size) {
            let same = true;
            for (const index of current) {
              if (!nextHidden.has(index)) {
                same = false;
                break;
              }
            }
            if (same) return current;
          }
          return nextHidden;
        });
      });
    };

    syncVisibleLanes();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", syncVisibleLanes);
      return () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("resize", syncVisibleLanes);
      };
    }

    const observer = new ResizeObserver(syncVisibleLanes);
    observer.observe(row);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [laneVisibilityKey]);

  // The row container always renders so the strip's vertical space is
  // reserved (CSS `min-height`), even when every lane is empty or hidden.
  // This stops the composer from popping up when the last suggestion fades
  // out and back down when the first one fades in.
  const resolvedIndicator: InlineWorkingIndicatorMountProps =
    indicator ?? { active: false, tasks: [] };

  return (
    <div
      ref={rowRef}
      className="composer-context-actions composer-context-actions--suggestions"
    >
      <div className="composer-context-working-indicator">
        <InlineWorkingIndicator {...resolvedIndicator} />
      </div>
      <div className="composer-context-suggestion-lanes">
        {lanes.map((lane, index) => (
          <SuggestionLaneView
            key={`lane-${index}`}
            index={index}
            lane={lane}
            setChatContext={setChatContext}
            onDismissCurrent={dismissSlot}
            isChipAttached={isChipAttached}
            overflowHidden={hiddenLaneIndexes.has(index)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One slot position in the suggestion strip. Renders the lane's `current`
 * occupant (entering/stable) and `outgoing` occupant (leaving) stacked in
 * the same grid cell — they overlap during a swap so the strip never goes
 * blank between two sets of chips.
 */
function SuggestionLaneView({
  index,
  lane,
  setChatContext,
  onDismissCurrent,
  isChipAttached,
  overflowHidden,
}: {
  index: number;
  lane: SuggestionLane;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  onDismissCurrent: (slotKey: string) => void;
  isChipAttached: (chip: SuggestionChip) => boolean;
  overflowHidden: boolean;
}) {
  const showCurrent = Boolean(
    lane.current && !isChipAttached(lane.current.chip),
  );
  const showOutgoing = Boolean(lane.outgoing);

  if (!showCurrent && !showOutgoing) return null;

  return (
    <div
      className="composer-context-suggestion-lane"
      data-lane-index={index}
      data-overflow-hidden={overflowHidden || undefined}
    >
      {showOutgoing && lane.outgoing ? (
        <SuggestionChipSlot
          slot={lane.outgoing}
          setChatContext={setChatContext}
          onDismiss={() => {}}
        />
      ) : null}
      {showCurrent && lane.current ? (
        <SuggestionChipSlot
          slot={lane.current}
          setChatContext={setChatContext}
          onDismiss={() => onDismissCurrent(lane.current!.key)}
        />
      ) : null}
    </div>
  );
}

function SuggestionChipSlot({
  slot,
  setChatContext,
  onDismiss,
}: {
  slot: SuggestionSlot;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  onDismiss: () => void;
}) {
  const handleClick = () => {
    if (slot.chip.kind === "tab") {
      setChatContext(tabChipToChatContext(slot.chip));
      // Tab chips don't carry a pid (the chip identity is bundleId/url),
      // so fall back to a name-based capture here. The app suggestion
      // chip below uses pid for an exact CGWindow match.
      captureAppWindowAsync(
        { appName: slot.chip.browser, pid: null },
        setChatContext,
      );
    } else {
      setChatContext(appChipToChatContext(slot.chip));
      captureAppWindowAsync(
        {
          appName: slot.chip.name,
          pid: slot.chip.pid > 0 ? slot.chip.pid : null,
        },
        setChatContext,
      );
    }
    onDismiss();
  };

  if (slot.chip.kind === "tab") {
    return (
      <TabSuggestionChip
        tab={slot.chip}
        phase={slot.phase}
        onClick={handleClick}
      />
    );
  }
  return (
    <AppSuggestionChip
      app={slot.chip}
      phase={slot.phase}
      onClick={handleClick}
    />
  );
}

/**
 * Lazy capture: kick off `captureAppWindow` and patch the running
 * `chatContext` when the screenshot lands. Only patches if the user hasn't
 * since detached or replaced the context (we keep the patch keyed on the
 * app name so we don't clobber a different context the user attached
 * mid-flight). Pass `pid` when known — the main process uses it as a
 * reliable selector against `CGWindowListCopyWindowInfo`; falls back to
 * name-matching against `desktopCapturer` window sources otherwise.
 */
const captureAppWindowAsync = (
  target: { appName: string; pid: number | null },
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>,
): void => {
  const api = getElectronApi();
  const captureFn = api?.home?.captureAppWindow;
  if (!captureFn) {
    setChatContext((prev) =>
      prev ? { ...prev, capturePending: false } : prev,
    );
    return;
  }

  const { appName, pid } = target;

  void (async () => {
    try {
      const result = await captureFn({ appName, pid });
      const capture = result?.capture ?? null;
      setChatContext((prev) => {
        if (!prev?.window) return prev;
        if (prev.window.app !== appName) return prev;
        if (!capture) {
          return { ...prev, capturePending: false };
        }
        return {
          ...prev,
          window: {
            ...prev.window,
            // Prefer a freshly observed title over the one we attached
            // eagerly (the running app may have switched windows since).
            title: capture.title || prev.window.title,
          },
          windowScreenshot: capture.screenshot,
          capturePending: false,
        };
      });
    } catch (error) {
      console.warn("[home] captureAppWindow failed", error);
      setChatContext((prev) =>
        prev ? { ...prev, capturePending: false } : prev,
      );
    }
  })();
};

type SlotPhaseAttr = "stable" | "entering" | "leaving";

function AppSuggestionChip({
  app,
  phase,
  onClick,
}: {
  app: RecentAppChip;
  phase: SlotPhaseAttr;
  onClick: () => void;
}) {
  const detail = app.windowTitle
    ? `${app.name} — ${app.windowTitle}`
    : app.name;

  return (
    <button
      type="button"
      className="composer-context-suggestion"
      data-phase={phase}
      title={
        app.isActive
          ? `Add ${detail} (current window) as context`
          : `Add ${detail} as context`
      }
      onClick={(event) => {
        event.preventDefault();
        onClick();
        event.currentTarget.blur();
      }}
    >
      <span className="composer-context-suggestion__plus" aria-hidden="true">
        +
      </span>
      <ChipAppGlyph iconDataUrl={app.iconDataUrl} fallbackLabel={app.name} />
      {app.windowTitle && (
        <span className="composer-context-suggestion__meta">
          {truncateChipLabel(app.windowTitle)}
        </span>
      )}
    </button>
  );
}

function TabSuggestionChip({
  tab,
  phase,
  onClick,
}: {
  tab: BrowserTabChip;
  phase: SlotPhaseAttr;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="composer-context-suggestion composer-context-suggestion--tab"
      data-phase={phase}
      title={tab.title ? `${tab.title} — ${tab.url}` : tab.url}
      onClick={(event) => {
        event.preventDefault();
        onClick();
        event.currentTarget.blur();
      }}
    >
      <span className="composer-context-suggestion__plus" aria-hidden="true">
        +
      </span>
      <ChipAppGlyph iconDataUrl={tab.iconDataUrl} fallbackLabel={tab.browser} />
      <span className="composer-context-suggestion__meta">
        {truncateChipLabel(tab.host)}
      </span>
    </button>
  );
}

/**
 * Show the app/browser icon when we have one; otherwise fall back to the
 * truncated display name. Keeping the markup uniform across both branches
 * means the chip layout doesn't shift when icons load asynchronously or
 * fail to encode for a given app.
 */
function ChipAppGlyph({
  iconDataUrl,
  fallbackLabel,
}: {
  iconDataUrl?: string;
  fallbackLabel: string;
}) {
  if (iconDataUrl) {
    return (
      <img
        src={iconDataUrl}
        alt=""
        aria-hidden="true"
        className="composer-context-suggestion__icon"
        draggable={false}
      />
    );
  }
  return (
    <span className="composer-context-suggestion__label">
      {truncateChipLabel(fallbackLabel)}
    </span>
  );
}
