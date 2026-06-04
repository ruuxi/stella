import { WebContentsView, shell, type BrowserWindow } from "electron";

type WebsiteViewControllerOptions = {
  preloadPath: string;
  sessionPartition: string;
  getUrl: (params?: WebsiteViewParams) => string;
  isAllowedUrl: (url: string) => boolean;
};

const WEBSITE_VIEW_TOP_INSET = 38;
const WEBSITE_VIEW_LEFT_INSET = 170;

/** IPC channel used to push live theme tokens from the renderer down into
 *  the embedded website view without reloading the page. */
const WEBSITE_VIEW_THEME_CHANNEL = "stellaDesktopWebsite:themeChanged";

export type WebsiteViewLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WebsiteViewRoute = "store" | "billing";

/** Compact set of theme tokens the embedded website needs to render any
 *  desktop theme legibly. We only pass the colors that meaningfully drive
 *  contrast (foreground, muted text, borders, primary) plus optional
 *  surface/background tones; everything else either falls out of color-mix
 *  or stays on the website's own palette. */
export type WebsiteViewTheme = {
  mode?: "light" | "dark";
  foreground?: string;
  foregroundWeak?: string;
  border?: string;
  primary?: string;
  surface?: string;
  background?: string;
};

export type WebsiteViewParams = {
  route?: WebsiteViewRoute;
  tab?: string;
  packageId?: string;
  /** When `true`, the desktop appends `?embedded=1` and theme params so the
   *  website loads in transparent embedded mode against Stella's chrome. */
  embedded?: boolean;
  theme?: WebsiteViewTheme;
};

export class WebsiteViewController {
  private view: WebContentsView | null = null;
  private owner: BrowserWindow | null = null;
  private layout: WebsiteViewLayout | null = null;
  private latestTheme: WebsiteViewTheme | null = null;
  /** Last bounds actually pushed to the view. Live window resize fires a
   *  high-frequency stream of events; skipping `setBounds` when the computed
   *  bounds are unchanged avoids redundant native child-surface resizes /
   *  repaints of the (transparent) web layer. */
  private lastAppliedBounds: WebsiteViewLayout | null = null;

  /** Window currently owning the resize-tracking listeners installed by
   *  `attachResizeTracking`, plus the bound handler we'll remove with.
   *  `attachResizeTracking` is idempotent against the same window: re-
   *  attaching is a no-op rather than stacking another batch of five
   *  listeners (the bug `MaxListenersExceededWarning` was catching). */
  private resizeTrackedWindow: BrowserWindow | null = null;
  private resizeTrackingHandler: (() => void) | null = null;
  /** Closed-listener kept so we can remove it cleanly when detaching
   *  (e.g. on window swap) — otherwise it'd outlive the tracked window. */
  private resizeTrackedClosedHandler: (() => void) | null = null;

  constructor(private readonly options: WebsiteViewControllerOptions) {}

  /** Opaque backing color for the view. Only ever visible for the brief
   *  moment before the embedded page paints its own background, so we just
   *  match the desktop shell's light/dark base to avoid a flash. Mirrors the
   *  `backgroundColor` the full window itself is created with. */
  private backdropColorFor(theme: WebsiteViewTheme | null): string {
    return theme?.mode === "dark" ? "#101016" : "#f2f4f8";
  }

  private applyBackdropColor() {
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    view.setBackgroundColor(this.backdropColorFor(this.latestTheme));
  }

  private ensureView() {
    if (this.view && !this.view.webContents.isDestroyed()) {
      return this.view;
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        partition: this.options.sessionPartition,
        sandbox: false,
      },
    });

    // Opaque backing surface. A translucent WebContentsView forces
    // Chromium off the fast Direct Composition path on Windows, which made
    // the embedded Store/Billing scroll and interact with noticeable lag.
    // Instead the website paints its own theme-matched gradient in
    // `data-embedded="true"` mode (see the website's embedded styles), so an
    // opaque backing surface is invisible while restoring smooth
    // compositing. The color only shows for the brief moment before the page
    // paints, so we just match the desktop shell's light/dark base.
    view.setBackgroundColor(this.backdropColorFor(this.latestTheme));

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (this.options.isAllowedUrl(url)) {
        return { action: "allow" };
      }
      void shell.openExternal(url);
      return { action: "deny" };
    });

    view.webContents.on("will-navigate", (event, url) => {
      if (this.options.isAllowedUrl(url)) return;
      event.preventDefault();
      void shell.openExternal(url);
    });

    // Re-send the latest theme on every successful navigation. Before the
    // first paint the renderer has no preload bridge to listen on, so we
    // queue the tokens here and replay once the website's `onThemeChanged`
    // listener mounts. This also keeps the embedded view in sync after an
    // explicit reload (`view.webContents.reload()`).
    view.webContents.on("did-finish-load", () => {
      if (this.latestTheme) {
        this.sendTheme(this.latestTheme);
      }
    });

    view.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.warn(
        "[website-view] preload failed",
        JSON.stringify({
          preloadPath,
          message: error.message,
          stack: error.stack,
        }),
      );
    });

    this.view = view;
    return view;
  }

  private applyBounds(bounds: WebsiteViewLayout) {
    if (!this.view) return;
    const last = this.lastAppliedBounds;
    if (
      last &&
      last.x === bounds.x &&
      last.y === bounds.y &&
      last.width === bounds.width &&
      last.height === bounds.height
    ) {
      return;
    }
    this.lastAppliedBounds = bounds;
    this.view.setBounds(bounds);
  }

  private syncBounds() {
    if (!this.owner || !this.view || this.owner.isDestroyed()) return;
    const [width, height] = this.owner.getContentSize();
    if (this.layout) {
      const x = Math.max(0, Math.min(width, Math.round(this.layout.x)));
      const y = Math.max(0, Math.min(height, Math.round(this.layout.y)));
      this.applyBounds({
        x,
        y,
        width: Math.max(0, Math.min(width - x, Math.round(this.layout.width))),
        height: Math.max(0, Math.min(height - y, Math.round(this.layout.height))),
      });
      return;
    }
    this.applyBounds({
      x: WEBSITE_VIEW_LEFT_INSET,
      y: WEBSITE_VIEW_TOP_INSET,
      width: Math.max(0, width - WEBSITE_VIEW_LEFT_INSET),
      height: Math.max(0, height - WEBSITE_VIEW_TOP_INSET),
    });
  }

  setLayout(layout: WebsiteViewLayout | null) {
    this.layout = layout;
    this.syncBounds();
  }

  show(owner: BrowserWindow, params?: WebsiteViewParams) {
    this.owner = owner;
    const view = this.ensureView();
    if (!owner.contentView.children.includes(view)) {
      owner.contentView.addChildView(view);
    }
    this.syncBounds();
    if (params?.theme) {
      this.latestTheme = params.theme;
    }
    // Keep the opaque backing color in sync with the (possibly newly
    // arrived) theme so a dark-mode open never flashes the light base.
    this.applyBackdropColor();
    const target = this.options.getUrl(params);
    const current = view.webContents.getURL();
    // The route is the only navigation-worthy part of the URL — theme
    // tokens and other embedded params change frequently and should not
    // trigger a page reload (they're pushed live via IPC instead). We
    // compare URLs with the transient params stripped so a theme change
    // doesn't drop the user back at the top of the page and lose state.
    const targetKey = routeKeyOf(target);
    const currentKey = stripCacheBustingParams(current);
    if (currentKey !== targetKey) {
      void view.webContents.loadURL(target);
    } else if (params?.theme) {
      this.sendTheme(params.theme);
    }
  }

  /**
   * Warm the embedded view ahead of the user actually opening it. Creates
   * the `WebContentsView` and kicks off `loadURL` for the target route
   * *without* attaching it to any window, so the expensive cold-start work
   * (spinning up the renderer process, fetching the remote bundle, React
   * hydration, Convex connect, first paint) all happens offscreen. A later
   * `show()` for the same route key then short-circuits the reload and just
   * attaches the already-loaded view — turning a multi-second cold open into
   * an instant attach. This matters most on Windows, where the renderer +
   * GPU spin-up is slower and the transparent compositing path makes the
   * cold first paint visibly laggy.
   *
   * Idempotent: if the view is already loading/loaded the same route this is
   * a no-op, so it's safe to call from multiple warm-up triggers.
   */
  prewarm(params?: WebsiteViewParams) {
    const view = this.ensureView();
    if (params?.theme) {
      // Cache so `did-finish-load` replays it and the offscreen first paint
      // already matches the desktop theme (no light-gradient flash on show).
      this.latestTheme = params.theme;
    }
    const target = this.options.getUrl(params);
    const current = view.webContents.getURL();
    if (routeKeyOf(current) === routeKeyOf(target)) return;
    void view.webContents.loadURL(target);
  }

  /**
   * Push a fresh set of theme tokens to the embedded website without
   * reloading. Safe to call before the view exists — the most recent
   * theme is cached and re-sent once the view is created so a renderer
   * that fires `setTheme` first never loses the tokens.
   */
  setTheme(theme: WebsiteViewTheme) {
    this.latestTheme = theme;
    this.applyBackdropColor();
    this.sendTheme(theme);
  }

  private sendTheme(theme: WebsiteViewTheme) {
    const webContents = this.view?.webContents;
    if (!webContents || webContents.isDestroyed()) return;
    webContents.send(WEBSITE_VIEW_THEME_CHANNEL, theme);
  }

  goBack() {
    const webContents = this.view?.webContents;
    if (webContents && !webContents.isDestroyed() && webContents.canGoBack()) {
      webContents.goBack();
    }
  }

  goForward() {
    const webContents = this.view?.webContents;
    if (webContents && !webContents.isDestroyed() && webContents.canGoForward()) {
      webContents.goForward();
    }
  }

  reload() {
    const webContents = this.view?.webContents;
    if (webContents && !webContents.isDestroyed()) {
      webContents.reload();
    }
  }

  hasWebContentsId(id: number) {
    const webContents = this.view?.webContents;
    return Boolean(webContents && !webContents.isDestroyed() && webContents.id === id);
  }

  hide() {
    if (this.owner && this.view && !this.owner.isDestroyed()) {
      this.owner.contentView.removeChildView(this.view);
    }
    this.owner = null;
    // Force the next show()'s syncBounds to re-apply rather than short-circuit
    // on a stale cached value after the view was detached.
    this.lastAppliedBounds = null;
  }

  destroy() {
    this.hide();
    this.detachResizeTracking();
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
    this.view = null;
  }

  /**
   * Tear down the underlying `WebContentsView` (closing its renderer
   * process) while leaving resize tracking attached to the owning window.
   * `ensureView()` recreates the view lazily on the next `show()`/`prewarm()`
   * and the still-installed resize listeners re-sync its bounds. The cached
   * `latestTheme` is preserved so the re-warmed first paint matches the
   * desktop theme. Used by the main process's idle-destroy timer to drop the
   * resident store/billing renderer once the surface has been closed for a
   * while; `destroy()` stays the full teardown for window/app shutdown.
   */
  disposeView() {
    this.hide();
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
    this.view = null;
  }

  attachResizeTracking(window: BrowserWindow) {
    if (this.resizeTrackedWindow === window) {
      // Already wired against this window — calling again is a no-op
      // rather than stacking another batch of listeners.
      return;
    }
    this.detachResizeTracking();
    if (window.isDestroyed()) return;

    const handler = () => this.syncBounds();
    const closedHandler = () => {
      // The tracked window went away — drop our refs so the next
      // `attachResizeTracking` (against a fresh window) attaches cleanly.
      this.resizeTrackedWindow = null;
      this.resizeTrackingHandler = null;
      this.resizeTrackedClosedHandler = null;
    };

    window.on("resize", handler);
    window.on("maximize", handler);
    window.on("unmaximize", handler);
    window.on("enter-full-screen", handler);
    window.on("leave-full-screen", handler);
    window.once("closed", closedHandler);

    this.resizeTrackedWindow = window;
    this.resizeTrackingHandler = handler;
    this.resizeTrackedClosedHandler = closedHandler;
  }

  detachResizeTracking() {
    const tracked = this.resizeTrackedWindow;
    const handler = this.resizeTrackingHandler;
    const closedHandler = this.resizeTrackedClosedHandler;
    this.resizeTrackedWindow = null;
    this.resizeTrackingHandler = null;
    this.resizeTrackedClosedHandler = null;
    if (!tracked || tracked.isDestroyed()) return;
    if (handler) {
      tracked.removeListener("resize", handler);
      tracked.removeListener("maximize", handler);
      tracked.removeListener("unmaximize", handler);
      tracked.removeListener("enter-full-screen", handler);
      tracked.removeListener("leave-full-screen", handler);
    }
    if (closedHandler) {
      tracked.removeListener("closed", closedHandler);
    }
  }
}

/** Drop transient query params (theme tokens, embedded flag) so we can
 *  decide whether a `loadURL` is actually navigating to a new page or
 *  just refreshing presentation tokens. */
const TRANSIENT_PARAMS = new Set([
  "embedded",
  "fg",
  "fg-weak",
  "border",
  "primary",
  "surface",
  "bg",
  "mode",
]);

const stripCacheBustingParams = (rawUrl: string): string => {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (TRANSIENT_PARAMS.has(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
};

/** The "route key" we use to decide reload-vs-update. Matches everything
 *  in the URL except the transient params dropped above. */
const routeKeyOf = (rawUrl: string): string => stripCacheBustingParams(rawUrl);
