import { WebContentsView, shell, type BrowserWindow } from "electron";

type StoreWebViewControllerOptions = {
  preloadPath: string;
  sessionPartition: string;
  getStoreUrl: (params?: StoreWebViewParams) => string;
  isAllowedStoreUrl: (url: string) => boolean;
};

const STORE_VIEW_TOP_INSET = 38;
const STORE_VIEW_LEFT_INSET = 170;

export type StoreWebViewLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StoreWebViewParams = {
  tab?: string;
  packageId?: string;
};

export class StoreWebViewController {
  private view: WebContentsView | null = null;
  private owner: BrowserWindow | null = null;
  private layout: StoreWebViewLayout | null = null;

  constructor(private readonly options: StoreWebViewControllerOptions) {}

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

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (this.options.isAllowedStoreUrl(url)) {
        return { action: "allow" };
      }
      void shell.openExternal(url);
      return { action: "deny" };
    });

    view.webContents.on("will-navigate", (event, url) => {
      if (this.options.isAllowedStoreUrl(url)) return;
      event.preventDefault();
      void shell.openExternal(url);
    });

    view.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.warn(
        "[store-web] preload failed",
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
      x: STORE_VIEW_LEFT_INSET,
      y: STORE_VIEW_TOP_INSET,
      width: Math.max(0, width - STORE_VIEW_LEFT_INSET),
      height: Math.max(0, height - STORE_VIEW_TOP_INSET),
    });
  }

  setLayout(layout: StoreWebViewLayout | null) {
    this.layout = layout;
    this.syncBounds();
  }

  show(owner: BrowserWindow, params?: StoreWebViewParams) {
    this.owner = owner;
    const view = this.ensureView();
    if (!owner.contentView.children.includes(view)) {
      owner.contentView.addChildView(view);
    }
    this.syncBounds();
    const target = this.options.getStoreUrl(params);
    if (view.webContents.getURL() !== target) {
      void view.webContents.loadURL(target);
    }
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
