import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { ConvexProvider } from "convex/react";
import "./index.css";
import "./ui/register-styles";
import { ThemeProvider } from "./context/theme-context";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { convexClient } from "./infra/convex-client";
import { ToastProvider } from "./ui/toast";
import { PetOverlay } from "./shell/pet/PetOverlay";
import type { PetOverlayStatus } from "./shared/contracts/pet";

document.documentElement.dataset.stellaWindow = "pet";

const IDLE_PET_STATUS: PetOverlayStatus = {
  state: "idle",
  title: "",
  message: "",
  isLoading: false,
};

/**
 * Pet window React tree.
 *
 * The pet runs in its own small dedicated `BrowserWindow` (rather than
 * inside the screen-spanning overlay) so the OS-level click-through
 * problem disappears: clicks within the window's bounds go to the pet,
 * clicks outside the bounds go to whatever app is below — no
 * `setIgnoreMouseEvents` toggling required.
 */
export function PetWindowRoot() {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<PetOverlayStatus>(IDLE_PET_STATUS);

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    void window.electronAPI?.pet?.getState?.().then((snapshot) => {
      setOpen(snapshot.open);
      setStatus(snapshot.status);
    });
    const setOpenCleanup = window.electronAPI?.pet?.onSetOpen?.((next) => {
      setOpen(next);
    });
    if (setOpenCleanup) cleanups.push(setOpenCleanup);
    const statusCleanup = window.electronAPI?.pet?.onStatus?.((next) => {
      setStatus(next);
    });
    if (statusCleanup) cleanups.push(statusCleanup);
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  if (!open) {
    return null;
  }

  return (
    <PetOverlay
      open={open}
      status={status}
      onClose={() => {
        setOpen(false);
        window.electronAPI?.pet?.setOpen?.(false);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <ConvexProvider client={convexClient}>
      <ThemeProvider>
        <ToastProvider>
          <PetWindowRoot />
        </ToastProvider>
      </ThemeProvider>
    </ConvexProvider>
  </ErrorBoundary>,
);
