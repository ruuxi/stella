import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ArrowUp, Plus, Sparkles, X } from "lucide-react";
import { StellaAppMock } from "./panels/StellaAppMock";
import { RadialDialDemo } from "./panels/radial/RadialDialDemo";

type ShortcutsPhaseProps = {
  mode: "global" | "local";
  splitTransitionActive: boolean;
  onFinish: () => void;
};

type MenuActionId = "open-chat";

const MENU_ACTION: {
  id: MenuActionId;
  resultTitle: string;
  resultBody: string;
} = {
  id: "open-chat",
  resultTitle: "Chat tab opened",
  resultBody:
    "Right-click anywhere inside Stella to open the workspace panel. If it\u2019s already open, right-click again to close it.",
};

export function OnboardingShortcutsPhase({
  mode,
  splitTransitionActive,
  onFinish,
}: ShortcutsPhaseProps) {
  const menuSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [localResult, setLocalResult] = useState<MenuActionId | null>(null);
  const localResultCard = localResult ? MENU_ACTION : null;

  const handleMenuContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setSidebarOpen((prev) => {
        const next = !prev;
        if (next) setLocalResult("open-chat");
        return next;
      });
    },
    [],
  );

  // Reset transient state when switching between modes so re-entering a
  // phase shows the demo in its initial state.
  useEffect(() => {
    setSidebarOpen(false);
    setLocalResult(null);
  }, [mode]);

  const finishVisible = mode === "global" ? true : localResult !== null;

  return (
    <div className="onboarding-step-content onboarding-shortcuts-phase">
      <p className="onboarding-step-desc">
        {mode === "global"
          ? "Hold the trigger anywhere on your computer to open Stella's radial dial — capture, chat, add context, or speak."
          : "Inside Stella, the hold menu gives you fast context-aware actions on cards, notes, and other app content."}
      </p>

      <div className="onboarding-shortcuts-grid">
        {mode === "global" ? (
          <section className="onboarding-shortcut-demo onboarding-shortcut-demo--radial">
            <RadialDialDemo />
          </section>
        ) : (
          <section className="onboarding-shortcut-demo">
            <div className="onboarding-shortcut-demo__copy">
              <span className="onboarding-step-label">
                How to use Stella inside the app
              </span>
              <h3 className="onboarding-shortcut-demo__title">
                Right-click anywhere to open chat.
              </h3>
            </div>

            <div
              ref={menuSurfaceRef}
              className="onboarding-shortcut-surface onboarding-shortcut-surface--menu onboarding-shortcut-surface--stella"
              data-testid="shortcuts-menu-surface"
              data-menu-result={localResult ?? undefined}
              onContextMenu={handleMenuContextMenu}
            >
              <div
                className="onboarding-shortcut-stella-frame"
                aria-hidden="true"
                data-sidebar-open={sidebarOpen || undefined}
              >
                <StellaAppMock interactive={false} />
              </div>

              {sidebarOpen && (
                <div className="onboarding-shortcut-sidebar-demo">
                  <div className="onboarding-shortcut-sidebar-demo__header">
                    <div
                      className="onboarding-shortcut-sidebar-demo__avatar"
                      aria-hidden="true"
                    >
                      <Sparkles size={11} />
                    </div>
                    <span className="onboarding-shortcut-sidebar-demo__title">
                      Stella
                    </span>
                    <button
                      type="button"
                      className="onboarding-shortcut-sidebar-demo__close"
                      aria-label="Close chat"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSidebarOpen(false);
                      }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                  <div className="onboarding-shortcut-sidebar-demo__messages">
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--assistant">
                      Right-clicked into chat. What would you like to do here?
                    </div>
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--user">
                      Add a focus timer to my home
                    </div>
                    <div className="scene-effect__mini-shell-msg scene-effect__mini-shell-msg--assistant">
                      Done — there&#39;s a 25&#8209;minute Pomodoro card on home
                      now. Want me to start a session?
                    </div>
                  </div>
                  <div className="onboarding-shortcut-sidebar-demo__composer">
                    <span
                      className="onboarding-shortcut-sidebar-demo__composer-add"
                      aria-hidden="true"
                    >
                      <Plus size={11} />
                    </span>
                    <span className="onboarding-shortcut-sidebar-demo__composer-input">
                      Ask Stella...
                    </span>
                    <span
                      className="onboarding-shortcut-sidebar-demo__composer-submit"
                      aria-hidden="true"
                    >
                      <ArrowUp size={11} />
                    </span>
                  </div>
                </div>
              )}

              <div className="onboarding-shortcut-hint onboarding-shortcut-hint--left">
                Try it here
              </div>
            </div>
          </section>
        )}
      </div>

      <div
        className="onboarding-shortcut-result-description"
        data-visible={
          mode === "local" && localResultCard ? "true" : undefined
        }
      >
        {mode === "local" && localResultCard ? (
          <>
            <strong>{localResultCard.resultTitle}</strong>
            <span>{localResultCard.resultBody}</span>
          </>
        ) : null}
      </div>

      <button
        className="onboarding-confirm"
        data-visible={finishVisible}
        disabled={splitTransitionActive || !finishVisible}
        onClick={onFinish}
      >
        {mode === "global" ? "Continue" : "Finish"}
      </button>
    </div>
  );
}
