import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { getElectronApi } from "@/platform/electron/electron";
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
  type SuggestionSlot,
} from "./hooks/use-auto-context-chips";
import {
  STELLA_PIN_SUGGESTION_EVENT,
  type StellaPinSuggestionDetail,
} from "@/shared/lib/stella-suggestions";

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
// attached. Rendered floating ABOVE the composer shell (the chat sidebar
// opts into this; the full-shell composer doesn't use it today).
// ---------------------------------------------------------------------------

type ComposerSuggestionRowProps = {
  chatContext: ChatContext | null;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
};

export function ComposerSuggestionContextRow({
  chatContext,
  setChatContext,
}: ComposerSuggestionRowProps) {
  const { slots, dismissSlot, pinSuggestion } = useAutoContextChips(true);

  // Listen for externally-pinned suggestions (e.g. cmd+rc → "Open chat"
  // surfaces the right-clicked window as a one-shot suggestion). We dispatch
  // through a window event so the IPC handler doesn't need to know which
  // sidebar is mounted.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<StellaPinSuggestionDetail>).detail;
      if (detail?.chip) {
        pinSuggestion(detail.chip);
      }
    };
    window.addEventListener(STELLA_PIN_SUGGESTION_EVENT, handler);
    return () => {
      window.removeEventListener(STELLA_PIN_SUGGESTION_EVENT, handler);
    };
  }, [pinSuggestion]);

  // Hide a slot whose chip is equivalent to the currently-attached context
  // (we don't want "+ Brave – github.com" suggesting itself when it's the
  // attached chip). Slot still occupies its position, just renders empty.
  const attachedAppName = chatContext?.window?.app?.toLowerCase().trim() ?? null;
  const attachedUrl = chatContext?.browserUrl ?? null;

  const isChipAttached = (chip: SuggestionChip): boolean => {
    if (chip.kind === "tab") {
      return Boolean(attachedUrl && attachedUrl === chip.url);
    }
    return Boolean(
      attachedAppName && chip.name.toLowerCase().trim() === attachedAppName,
    );
  };

  const hasAnyVisible = slots.some(
    (slot) => slot && !isChipAttached(slot.chip),
  );
  if (!hasAnyVisible) return null;

  return (
    <div className="composer-context-actions composer-context-actions--suggestions">
      {slots.map((slot, index) => {
        if (!slot) {
          return <span key={`slot-empty-${index}`} className="composer-context-suggestion-placeholder" aria-hidden="true" />;
        }
        if (isChipAttached(slot.chip)) {
          return <span key={slot.key} className="composer-context-suggestion-placeholder" aria-hidden="true" />;
        }
        return (
          <SuggestionChipSlot
            key={slot.key}
            slot={slot}
            setChatContext={setChatContext}
            onDismiss={() => dismissSlot(slot.key)}
          />
        );
      })}
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
        { appName: slot.chip.name, pid: slot.chip.pid > 0 ? slot.chip.pid : null },
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
      <span className="composer-context-suggestion__label">{app.name}</span>
      {app.windowTitle && (
        <span className="composer-context-suggestion__meta">
          {app.windowTitle}
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
      <span className="composer-context-suggestion__label">{tab.host}</span>
      <span className="composer-context-suggestion__meta">
        in {tab.browser}
      </span>
    </button>
  );
}
