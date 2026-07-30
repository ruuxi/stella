import { useEffect } from "react";
import { showToast } from "@/ui/toast";

/**
 * Region/window capture runs entirely in the main process; when the capture
 * flow finishes but produces nothing (native capture failed end-to-end), the
 * main process broadcasts a failure signal instead of silently dropping the
 * result. This listener turns that into a visible toast so "I captured but
 * nothing showed up" never happens silently.
 */
export function CaptureErrorToastListener() {
  useEffect(() => {
    const off = window.electronAPI?.capture?.onRegionCaptureFailed?.(() => {
      showToast({
        title: "Couldn’t capture that",
        description: "Something went wrong taking the screenshot. Try again.",
        variant: "error",
      });
    });
    return () => {
      off?.();
    };
  }, []);

  return null;
}
