import { useEffect, useRef, useState } from "react";
import { RadialDial } from "./overlay/RadialDial";
import "./overlay/overlays.css";

type RadialState = {
  visible: boolean;
  position: { x: number; y: number } | null;
  miniVisible: boolean;
  fullVisible: boolean;
  fullEnabled: boolean;
};

const HIDE_DELAY_MS = 300;

export function WindowRadialOverlay() {
  const [state, setState] = useState<RadialState>({
    visible: false,
    position: null,
    miniVisible: false,
    fullVisible: false,
    fullEnabled: true,
  });
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.radial.onShow) {
      return;
    }

    const clearHideTimer = () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };

    const cleanupShow = api.radial.onShow((_event, data) => {
      if (
        typeof data.screenX !== "number" ||
        typeof data.screenY !== "number"
      ) {
        return;
      }

      clearHideTimer();
      setState({
        visible: true,
        position: { x: data.screenX, y: data.screenY },
        miniVisible: data.compactFocused ?? false,
        fullVisible: data.fullFocused ?? false,
        fullEnabled: data.fullEnabled ?? true,
      });
    });

    const cleanupHide = api.radial.onHide(() => {
      clearHideTimer();
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        setState((current) => ({
          ...current,
          visible: false,
          miniVisible: false,
          fullVisible: false,
          fullEnabled: true,
        }));
      }, HIDE_DELAY_MS);
    });

    return () => {
      clearHideTimer();
      cleanupShow();
      cleanupHide();
    };
  }, []);

  if (!state.visible || !state.position) {
    return null;
  }

  return (
    <div
      className="radial-shell"
      style={{
        position: "fixed",
        left: state.position.x,
        top: state.position.y,
        zIndex: 200,
        pointerEvents: "none",
      }}
      aria-hidden
    >
      <RadialDial
        miniVisible={state.miniVisible}
        fullVisible={state.fullVisible}
        fullEnabled={state.fullEnabled}
      />
    </div>
  );
}
