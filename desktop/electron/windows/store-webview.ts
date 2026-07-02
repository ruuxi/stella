import { shell, type BrowserWindow } from "electron";

/**
 * Guard rails for the in-DOM `<webview>` tag that hosts the embedded
 * stella.sh Store/Billing pages inside the full shell window.
 *
 * The embed used to be a main-process `WebContentsView` composited over the
 * window, which required manual bounds syncing and overlay suppression in the
 * renderer. It is now a plain `<webview>` element owned by the renderer DOM;
 * this module keeps the main-process responsibilities that remain:
 *
 * - `will-attach-webview`: only allow guests pointed at the first-party
 *   store origin, and force the safe web preferences (our preload, no node
 *   integration, context isolation) regardless of what the tag asked for.
 * - `did-attach-webview`: apply the same navigation policy the old
 *   `WebsiteViewController` had — same-origin navigations/popups stay inside,
 *   everything else opens in the system browser — and track the guest
 *   webContents id so `storeWeb:*` IPC can verify its sender.
 */

type StoreWebviewGuardOptions = {
  preloadPath: string;
  isAllowedUrl: (url: string) => boolean;
};

const attachedStoreWebviewIds = new Set<number>();

/** Whether `id` belongs to a currently-attached store/billing `<webview>`. */
export const isStoreWebviewWebContents = (id: number) =>
  attachedStoreWebviewIds.has(id);

export const attachStoreWebviewGuards = (
  window: BrowserWindow,
  options: StoreWebviewGuardOptions,
) => {
  window.webContents.on(
    "will-attach-webview",
    (event, webPreferences, params) => {
      const src = typeof params.src === "string" ? params.src : "";
      if (!options.isAllowedUrl(src)) {
        console.warn(
          `[security] Blocked webview attach for disallowed src ${src || "(empty)"}`,
        );
        event.preventDefault();
        return;
      }
      // Force the safe guest configuration regardless of tag attributes.
      delete (webPreferences as { preloadURL?: string }).preloadURL;
      webPreferences.preload = options.preloadPath;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      // Matches the old WebContentsView config; the preload only uses
      // `contextBridge`/`ipcRenderer`, but keep sandbox behavior identical.
      webPreferences.sandbox = false;
    },
  );

  window.webContents.on("did-attach-webview", (_event, guestContents) => {
    const guestId = guestContents.id;
    attachedStoreWebviewIds.add(guestId);
    guestContents.once("destroyed", () => {
      attachedStoreWebviewIds.delete(guestId);
    });

    guestContents.setWindowOpenHandler(({ url }) => {
      if (options.isAllowedUrl(url)) {
        return { action: "allow" };
      }
      void shell.openExternal(url);
      return { action: "deny" };
    });

    guestContents.on("will-navigate", (event, url) => {
      if (options.isAllowedUrl(url)) return;
      event.preventDefault();
      void shell.openExternal(url);
    });
  });
};
