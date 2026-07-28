import { X } from "@/ui/icons";
import { displayTabs } from "@/features/workspace-display/tab-store";

export const DisplayPanelControls = () => {
  return (
    <div className="shell-topbar-display-controls">
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
