import { useCallback } from "react";
import { SlidersHorizontal } from "lucide-react";
import {
  engineOverlay,
  useEngineOverlayOpen,
} from "./engine-overlay-store";

export function DisplaySidebarModelsButton() {
  const isOpen = useEngineOverlayOpen();

  const handleClick = useCallback(() => {
    engineOverlay.toggle();
  }, []);

  return (
    <button
      type="button"
      className="display-sidebar__models-btn pill-btn"
      onClick={handleClick}
      aria-pressed={isOpen}
      aria-current={isOpen ? "page" : undefined}
      title={isOpen ? "Hide models" : "Models and engine"}
    >
      <SlidersHorizontal
        size={13}
        strokeWidth={1.75}
        aria-hidden
        className="display-sidebar__models-btn-icon"
      />
      <span>Models</span>
    </button>
  );
}
