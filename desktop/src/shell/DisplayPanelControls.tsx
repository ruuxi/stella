import { ArrowLeft, ArrowRight, Maximize2, Minimize2, X } from "@/ui/icons";
import { useWindowType } from "@/shared/hooks/use-window-type";
import {
  displayTabs,
  useDisplayNav,
  useDisplayPanelExpanded,
} from "@/features/workspace-display/tab-store";

export const DisplayPanelControls = () => {
  const isMiniWindow = useWindowType() === "mini";
  const panelExpanded = useDisplayPanelExpanded();
  const { canGoBack, canGoForward } = useDisplayNav();

  return (
    <div className="shell-topbar-display-controls">
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => displayTabs.back()}
        disabled={!canGoBack}
        aria-label="Back"
        title="Back"
      >
        <ArrowLeft size={15} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => displayTabs.forward()}
        disabled={!canGoForward}
        aria-label="Forward"
        title="Forward"
      >
        <ArrowRight size={15} strokeWidth={1.75} />
      </button>
      {!isMiniWindow ? (
        <button
          type="button"
          className="shell-topbar-icon-btn shell-topbar-display-expand"
          onClick={() => displayTabs.togglePanelExpanded()}
          aria-label={panelExpanded ? "Restore panel size" : "Expand panel"}
          aria-pressed={panelExpanded}
          title={panelExpanded ? "Restore panel size" : "Expand panel"}
        >
          {panelExpanded ? (
            <Minimize2 size={14} strokeWidth={1.75} />
          ) : (
            <Maximize2 size={14} strokeWidth={1.75} />
          )}
        </button>
      ) : null}
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => displayTabs.setPanelOpen(false)}
        aria-label="Close viewer"
        title="Close viewer"
      >
        <X size={16} strokeWidth={1.85} />
      </button>
    </div>
  );
};
