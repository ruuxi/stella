import { useCallback, useState } from "react";
import { useViewportActivity } from "@/shared/hooks/useViewportActivity";
import { RadialDialInteractive } from "./RadialDialInteractive";
import { RadialDialVisual } from "./RadialDialVisual";
import { RADIAL_WEDGES } from "./data";
import "./radial-unified.css";

export function RadialDialDemo() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { ref, isActive } = useViewportActivity<HTMLDivElement>({
    rootMargin: "360px 0px",
  });

  const handleSelect = useCallback((index: number) => {
    setSelectedIndex((current) => (current === index ? current : index));
  }, []);

  const activeWedge = RADIAL_WEDGES[selectedIndex];

  return (
    <div className="onboarding-radial-root radial-hero">
      <div className="radial-hero__stage">
        <div className="radial-hero__dial" aria-label="Stella radial dial">
          <RadialDialInteractive
            selectedIndex={selectedIndex}
            onSelect={handleSelect}
          />
          <div className="radial-dial-caption" aria-live="polite">
            <div key={activeWedge.id} className="radial-dial-caption__inner">
              <strong>{activeWedge.heading}</strong>
              <p>{activeWedge.detail}</p>
            </div>
          </div>
        </div>

        <div ref={ref} className="radial-hero__mock">
          <RadialDialVisual
            selectedIndex={selectedIndex}
            isActive={isActive}
          />
        </div>
      </div>
    </div>
  );
}
