import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPlatform } from "@/platform/electron/platform";
import { useViewportActivity } from "@/shared/hooks/useViewportActivity";
import { getRadialTriggerLabel } from "@/shared/lib/radial-trigger";
import { Keychord } from "../../Keychord";
import { RadialDialInteractive } from "./RadialDialInteractive";
import { RadialDialVisual } from "./RadialDialVisual";
import { RADIAL_WEDGES } from "./data";
import "./radial-unified.css";

type RadialDialDemoProps = {
  /** Fired the first time the user successfully holds the trigger chord
   *  (or activates via the keyboard). The shortcuts phase uses this to
   *  reveal the Continue button. */
  onActivated?: () => void;
};

export function RadialDialDemo({ onActivated }: RadialDialDemoProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activated, setActivated] = useState(false);
  const activatedRef = useRef(false);
  const { ref, isActive } = useViewportActivity<HTMLDivElement>({
    rootMargin: "360px 0px",
  });

  const handleSelect = useCallback((index: number) => {
    setSelectedIndex((current) => (current === index ? current : index));
  }, []);

  const platform = getPlatform();
  const activeWedge = RADIAL_WEDGES[selectedIndex];
  const triggerKeys = useMemo(() => {
    const label = getRadialTriggerLabel("SystemChord", platform);
    return label.split(" + ");
  }, [platform]);

  const triggerKeyAria = useMemo(
    () => triggerKeys.join(" plus "),
    [triggerKeys],
  );

  const triggerActivation = useCallback(() => {
    if (activatedRef.current) return;
    activatedRef.current = true;
    setActivated(true);
    onActivated?.();
  }, [onActivated]);

  // Detect the radial chord (Option/Alt + Cmd/Meta on macOS, Alt + Meta
  // on Windows/Linux). We watch keydown for the moment both modifiers
  // are held simultaneously — this is a teaching surface, so we only
  // need the first activation, not continuous tracking.
  useEffect(() => {
    if (activatedRef.current) return;

    const isModifierPressed = (event: KeyboardEvent): boolean => {
      const altDown = event.altKey;
      const metaDown = event.metaKey;
      return altDown && metaDown;
    };

    const handler = (event: KeyboardEvent) => {
      if (activatedRef.current) return;
      if (isModifierPressed(event)) {
        triggerActivation();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [triggerActivation]);

  return (
    <div
      className="onboarding-radial-root radial-hero"
      data-activated={activated || undefined}
    >
      <div className="radial-hero__stage">
        {activated ? (
          <>
            <div
              className="radial-hero__dial"
              aria-label="Stella radial dial"
            >
              <RadialDialInteractive
                selectedIndex={selectedIndex}
                onSelect={handleSelect}
              />
              <div className="radial-dial-caption" aria-live="polite">
                <div
                  key={activeWedge.id}
                  className="radial-dial-caption__inner"
                >
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
          </>
        ) : (
          <div className="radial-hero__prompt">
            <Keychord
              aria={triggerKeyAria}
              glyphs={triggerKeys}
              highlight
            />
            <p className="radial-hero__prompt-text">
              Hold this anywhere on your computer to open Stella's radial
              dial.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
