/**
 * Standalone Activity — the agent index beside the main app.
 *
 * Search and agent-thread viewers live in the right sidebar's Work section;
 * this surface stays a lightweight ambient activity list.
 */

import { useEffect } from "react";
import { openEngineDisplayTab } from "@/features/workspace-display/default-tabs";
import { ModelsPicker } from "@/global/settings/ModelsPicker";
import {
  engineOverlay,
  useEngineOverlayOpen,
} from "@/shell/display/engine-overlay-store";
import { WorkspaceSections } from "@/shell/workspace/WorkspaceSections";
import { SlidersHorizontal } from "@/ui/icons";
import "./home-search.css";

export function ActivityOverview({
  onNavigate,
  showModels = true,
}: {
  onNavigate?: () => void;
  showModels?: boolean;
} = {}) {
  const modelsPickerOpen = useEngineOverlayOpen();

  return (
    <div className="sidebar-search">
      <div className="sidebar-search__body">
        <WorkspaceSections
          variant="overview"
          searchMode="quick"
          onNavigate={onNavigate}
        />
      </div>
      {showModels ? (
        <div className="sidebar-home-footer">
          <ModelsPicker
            open={modelsPickerOpen}
            onOpenChange={engineOverlay.setOpen}
            side="top"
            align="end"
            trigger={
              <button
                type="button"
                className="pill-btn sidebar-home-models-button"
              >
                <SlidersHorizontal size={14} strokeWidth={1.75} />
                Models
              </button>
            }
          />
        </div>
      ) : null}
    </div>
  );
}

export function HomeSection() {
  useEffect(() => {
    const handleOpenModelPicker = () => openEngineDisplayTab();
    window.addEventListener("stella:open-model-picker", handleOpenModelPicker);
    return () => {
      window.removeEventListener(
        "stella:open-model-picker",
        handleOpenModelPicker,
      );
    };
  }, []);
  return <ActivityOverview />;
}
