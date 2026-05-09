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

  constructor(private readonly options: WebsiteViewControllerOptions) {}

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

    // Transparent backing surface: the embedded website paints its own
    // body transparent in `data-embedded="true"` mode so the desktop's
    // shifting-gradient theme canvas underneath is visible. Without this,
    // Chromium's default opaque white frame would block it.
    view.setBackgroundColor("#00000000");

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

  private syncBounds() {
    if (!this.owner || !this.view || this.owner.isDestroyed()) return;
    const [width, height] = this.owner.getContentSize();
    if (this.layout) {
      const x = Math.max(0, Math.min(width, Math.round(this.layout.x)));
      const y = Math.max(0, Math.min(height, Math.round(this.layout.y)));
      this.view.setBounds({
        x,
        y,
        width: Math.max(
          0,
          Math.min(width - x, Math.round(this.layout.width)),
        ),
        height: Math.max(
          0,
          Math.min(height - y, Math.round(this.layout.height)),
        ),
      });
      return;
    }
    this.view.setBounds({
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
   * Push a fresh set of theme tokens to the embedded website without
   * reloading. Safe to call before the view exists — the most recent
   * theme is cached and re-sent once the view is created so a renderer
   * that fires `setTheme` first never loses the tokens.
   */
  setTheme(theme: WebsiteViewTheme) {
    this.latestTheme = theme;
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
  }

  destroy() {
    this.hide();
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
    this.view = null;
  }

  attachResizeTracking(window: BrowserWindow) {
    window.on("resize", () => this.syncBounds());
    window.on("maximize", () => this.syncBounds());
    window.on("unmaximize", () => this.syncBounds());
    window.on("enter-full-screen", () => this.syncBounds());
    window.on("leave-full-screen", () => this.syncBounds());
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
