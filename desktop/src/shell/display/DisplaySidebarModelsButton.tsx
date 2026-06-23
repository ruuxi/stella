import { SlidersHorizontal } from "@/ui/icons";
import { ModelsPicker } from "@/global/settings/ModelsPicker";
import {
  engineOverlay,
  useEngineOverlayOpen,
} from "./engine-overlay-store";

export function DisplaySidebarModelsButton() {
  const isOpen = useEngineOverlayOpen();

  return (
    <ModelsPicker
      open={isOpen}
      onOpenChange={engineOverlay.setOpen}
      side="right"
      align="end"
      trigger={
        <button
          type="button"
          className="display-sidebar__models-btn pill-btn"
          title={isOpen ? "Hide models" : "Models and engine"}
          data-active={isOpen || undefined}
        >
          <SlidersHorizontal
            size={13}
            strokeWidth={1.75}
            aria-hidden
            className="display-sidebar__models-btn-icon"
          />
          <span>Models</span>
        </button>
      }
    />
  );
}
