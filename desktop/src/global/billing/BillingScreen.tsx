import { useCallback, useEffect, useRef } from "react";
import { useDisplayPanelLayout } from "@/shell/display/tab-store";
import { useEmbeddedWebsiteTheme } from "@/global/website-view/use-embedded-website-theme";

export function BillingScreen() {
  const { panelOpen, panelExpanded, panelWidth } = useDisplayPanelLayout();
  const layoutFrameRef = useRef<number | null>(null);
  const embeddedTheme = useEmbeddedWebsiteTheme();

  const syncBillingWebLayout = useCallback(() => {
    const contentArea = document.querySelector<HTMLElement>(".content-area");
    if (!contentArea) return;
    const rect = contentArea.getBoundingClientRect();
    const styles = window.getComputedStyle(contentArea);
    const topInset = Number.parseFloat(styles.paddingTop) || 0;
    void window.electronAPI?.storeWeb?.setLayout?.({
      x: Math.round(rect.left),
      y: Math.round(rect.top + topInset),
      width: panelOpen && panelExpanded ? 0 : Math.round(rect.width),
      height: Math.max(0, Math.round(rect.height - topInset)),
    });
  }, [panelExpanded, panelOpen]);

  const scheduleBillingWebLayout = useCallback(() => {
    if (layoutFrameRef.current !== null) return;
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = null;
      syncBillingWebLayout();
    });
  }, [syncBillingWebLayout]);

  useEffect(() => {
    scheduleBillingWebLayout();
    const contentArea = document.querySelector<HTMLElement>(".content-area");
    const displaySidebar =
      document.querySelector<HTMLElement>(".display-sidebar");
    const resizeObserver = new ResizeObserver(scheduleBillingWebLayout);
    if (contentArea) resizeObserver.observe(contentArea);
    if (displaySidebar) resizeObserver.observe(displaySidebar);
    window.addEventListener("resize", scheduleBillingWebLayout);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleBillingWebLayout);
      if (layoutFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutFrameRef.current);
        layoutFrameRef.current = null;
      }
    };
  }, [panelExpanded, panelOpen, panelWidth, scheduleBillingWebLayout]);

  useEffect(() => {
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      syncBillingWebLayout();
      void window.electronAPI?.storeWeb?.show({
        route: "billing",
        embedded: true,
        theme: embeddedTheme,
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      void window.electronAPI?.storeWeb?.hide();
    };
    // `embeddedTheme` intentionally omitted: live theme updates flow
    // through `useEmbeddedWebsiteTheme`'s own `setTheme` IPC, so we don't
    // want to re-issue `show()` (which can race the route navigation)
    // every time the user previews a theme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncBillingWebLayout]);

  return (
    <div className="workspace-area">
      <div className="workspace-content workspace-content--full" />
    </div>
  );
}
