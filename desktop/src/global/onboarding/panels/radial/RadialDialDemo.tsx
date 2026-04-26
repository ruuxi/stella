import { useCallback, useMemo, useState } from "react";
import { getPlatform } from "@/platform/electron/platform";
import { useViewportActivity } from "@/shared/hooks/useViewportActivity";
import { getRadialTriggerLabel } from "@/shared/lib/radial-trigger";
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
  const triggerKeys = useMemo(() => {
    const label = getRadialTriggerLabel("SystemChord", getPlatform());
    return label.split(" + ");
  }, []);

  return (
    <div className="onboarding-radial-root radial-hero">
      <div className="radial-hero__stage">
        <div className="radial-hero__dial" aria-label="Stella radial dial">
          <p className="radial-trigger-hint">
            Hold{" "}
            <span className="radial-trigger-combo" aria-label="radial dial shortcut">
              {triggerKeys.map((key, index) => (
                <span className="radial-trigger-combo__part" key={key}>
                  {index > 0 ? <span aria-hidden="true">+</span> : null}
                  <kbd className="radial-trigger-kbd">{key}</kbd>
                </span>
              ))}
            </span>{" "}
            to open the radial dial.
          </p>
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
