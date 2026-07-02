import { useEffect, useMemo, useRef, useState } from "react";
import type {
  EmbeddedWebsiteTheme,
  StoreWebEmbedConfig,
} from "@/shared/types/electron";
import "./EmbeddedWebsiteView.css";

/**
 * In-DOM `<webview>` host for the embedded stella.sh Store/Billing pages.
 *
 * This replaces the old main-process `WebContentsView` embed 1:1:
 * - session/partition: same `persist:…:website` partition (via
 *   `storeWeb:getEmbedConfig`), so cookies/login carry over identically.
 * - desktop bridge: the same `store-web-preload` script, passed through the
 *   tag's `preload` attribute (a `file:` URL) and re-enforced by main in
 *   `will-attach-webview`.
 * - theme: initial tokens ride the URL (synchronous first paint), live
 *   updates are pushed over the same `stellaDesktopWebsite:themeChanged`
 *   channel — now via `webview.send()` instead of a main-process hop — and
 *   the latest theme is replayed on every `did-finish-load`.
 * - navigation/popups: policed by main via `did-attach-webview`
 *   (same-origin stays in, everything else opens externally).
 *
 * Because the webview is a DOM element, layout/resize and overlay stacking
 * are handled by CSS — no manual bounds syncing, no overlay suppression.
 */

const WEBSITE_VIEW_THEME_CHANNEL = "stellaDesktopWebsite:themeChanged";

/** The Electron `<webview>` element methods we use. React types the tag as
 *  `HTMLWebViewElement` (a bare `HTMLElement`), so narrow it locally. */
type StellaWebviewElement = HTMLElement & {
  send: (channel: string, ...args: unknown[]) => void;
};

let embedConfigPromise: Promise<StoreWebEmbedConfig | null> | null = null;

const getEmbedConfig = (): Promise<StoreWebEmbedConfig | null> => {
  embedConfigPromise ??= (async () => {
    try {
      const config =
        (await window.electronAPI?.storeWeb?.getEmbedConfig?.()) ?? null;
      if (!config) embedConfigPromise = null;
      return config;
    } catch {
      embedConfigPromise = null;
      return null;
    }
  })();
  return embedConfigPromise;
};

/**
 * Build the embed URL. Theme tokens are included as URL params so the
 * website can apply them synchronously before first paint (no flash of the
 * default light gradient); afterwards live theme changes flow over IPC and
 * deliberately do NOT change the URL (so they never reload the page).
 */
const buildEmbedUrl = (
  baseUrl: string,
  params: {
    route: "store" | "billing";
    tab?: string;
    packageId?: string;
    theme?: EmbeddedWebsiteTheme;
  },
): string => {
  const url = new URL(baseUrl);
  url.pathname = params.route === "billing" ? "/billing" : "/store";
  url.search = "";
  if (params.route !== "billing" && params.tab) {
    url.searchParams.set("tab", params.tab);
  }
  if (params.route !== "billing" && params.packageId) {
    url.searchParams.set("package", params.packageId);
  }
  url.searchParams.set("embedded", "1");
  const theme = params.theme;
  if (theme) {
    const setIfPresent = (key: string, value: string | undefined) => {
      const trimmed = value?.trim();
      if (trimmed) url.searchParams.set(key, trimmed);
    };
    if (theme.mode === "light" || theme.mode === "dark") {
      url.searchParams.set("mode", theme.mode);
    }
    setIfPresent("fg", theme.foreground);
    setIfPresent("fg-weak", theme.foregroundWeak);
    setIfPresent("border", theme.border);
    setIfPresent("primary", theme.primary);
    setIfPresent("surface", theme.surface);
    setIfPresent("bg", theme.background);
  }
  return url.toString();
};

type EmbeddedWebsiteViewProps = {
  route: "store" | "billing";
  tab?: string;
  packageId?: string;
  theme: EmbeddedWebsiteTheme;
};

export function EmbeddedWebsiteView({
  route,
  tab,
  packageId,
  theme,
}: EmbeddedWebsiteViewProps) {
  const [config, setConfig] = useState<StoreWebEmbedConfig | null>(null);
  const webviewRef = useRef<StellaWebviewElement | null>(null);
  const latestThemeRef = useRef(theme);
  latestThemeRef.current = theme;
  // Captured once: the theme only seeds the initial URL. Live changes are
  // pushed over IPC below and must not rewrite `src` (that would reload).
  const initialThemeRef = useRef(theme);

  useEffect(() => {
    let cancelled = false;
    void getEmbedConfig().then((resolved) => {
      if (!cancelled) setConfig(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const src = useMemo(
    () =>
      config
        ? buildEmbedUrl(config.baseUrl, {
            route,
            tab,
            packageId,
            theme: initialThemeRef.current,
          })
        : null,
    [config, route, tab, packageId],
  );

  // Replay the latest theme on every successful navigation: before first
  // paint the guest has no listener mounted yet, and an in-page reload
  // would otherwise lose the live tokens. Mirrors the old controller's
  // `did-finish-load` replay exactly.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const replayTheme = () => {
      try {
        webview.send(WEBSITE_VIEW_THEME_CHANNEL, latestThemeRef.current);
      } catch {
        // Guest not attached yet — the next did-finish-load replays it.
      }
    };
    webview.addEventListener("did-finish-load", replayTheme);
    return () => {
      webview.removeEventListener("did-finish-load", replayTheme);
    };
  }, [src]);

  // Push live theme updates without reloading.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    try {
      webview.send(WEBSITE_VIEW_THEME_CHANNEL, theme);
    } catch {
      // Guest not attached yet — the did-finish-load replay covers it.
    }
  }, [theme, src]);

  if (!config || !src) {
    // Config fetch is a single fast IPC round-trip; render the (theme-
    // matched) empty container rather than a spinner for the interim frame.
    return <div className="embedded-website-view" aria-hidden="true" />;
  }

  return (
    <webview
      ref={(element) => {
        webviewRef.current = element as StellaWebviewElement | null;
      }}
      className="embedded-website-view"
      src={src}
      partition={config.partition}
      preload={config.preloadUrl}
      // Same-origin popups (OAuth, checkout) open as real windows; main's
      // window-open handler sends everything else to the system browser.
      allowpopups
    />
  );
}
