import { useLayoutEffect, useEffect, useState, useSyncExternalStore } from "react";

type Listener = () => void;

let activeOverlayCount = 0;
const listeners = new Set<Listener>();

const emit = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => activeOverlayCount > 0;

export const registerNativeWebsiteBlockingOverlay = () => {
  activeOverlayCount += 1;
  emit();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeOverlayCount = Math.max(0, activeOverlayCount - 1);
    emit();
  };
};

export const useNativeWebsiteOverlaySuspended = () =>
  useSyncExternalStore(subscribe, getSnapshot, () => false);

export const useRegisterNativeWebsiteBlockingOverlay = () => {
  useLayoutEffect(() => registerNativeWebsiteBlockingOverlay(), []);
};

export const useNativeWebsiteBlockingOverlay = (active: boolean) => {
  useLayoutEffect(() => {
    if (!active) return;
    return registerNativeWebsiteBlockingOverlay();
  }, [active]);
};

export const useNativeWebsiteGlassSuspension = (fadeMs = 180) => {
  const overlayActive = useNativeWebsiteOverlaySuspended();
  const [viewSuspended, setViewSuspended] = useState(overlayActive);
  const [placeholderVisible, setPlaceholderVisible] = useState(overlayActive);
  const [placeholderActive, setPlaceholderActive] = useState(false);

  useEffect(() => {
    let frame = 0;
    let timeout = 0;

    if (overlayActive) {
      setPlaceholderVisible(true);
      setViewSuspended(true);
      frame = window.requestAnimationFrame(() => {
        setPlaceholderActive(true);
      });
      return;
    }

    setPlaceholderActive(false);
    timeout = window.setTimeout(() => {
      setViewSuspended(false);
      setPlaceholderVisible(false);
    }, fadeMs);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (timeout) window.clearTimeout(timeout);
    };
  }, [fadeMs, overlayActive]);

  return {
    viewSuspended,
    placeholderVisible,
    placeholderActive,
  };
};
