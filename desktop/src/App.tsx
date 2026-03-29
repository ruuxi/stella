import { Suspense, lazy, useEffect } from "react";
import { useUiState } from "@/context/ui-state";
import { getElectronApi } from "@/platform/electron/electron";
import { AuthDeepLinkHandler } from "./global/auth/AuthDeepLinkHandler";
import { PhoneAccessBridge } from "./global/mobile/PhoneAccessBridge";
import { AppBootstrap } from "./systems/boot/AppBootstrap";
import { ModelPreferencesBridge } from "@/global/settings/ModelPreferencesBridge";
import { ChatStoreProvider } from "@/context/chat-store";

type WindowType = "full" | "mini";
const AUTO_REPAIR_SIGNATURE_KEY = "stella:auto-repair:last-signature";
const CredentialRequestLayer = lazy(() =>
  import("./global/auth/CredentialRequestLayer").then((module) => ({
    default: module.CredentialRequestLayer,
  })),
);
const FullShell = lazy(() =>
  import("./shell/FullShell").then((module) => ({ default: module.FullShell })),
);
const MiniShell = lazy(() =>
  import("./shell/mini/MiniShell").then((module) => ({
    default: module.MiniShell,
  })),
);

function App() {
  const { state } = useUiState();
  const api = getElectronApi();
  const windowParam = new URLSearchParams(window.location.search).get("window");
  const isElectron = Boolean(api);
  const windowType: WindowType = isElectron
    ? windowParam === "mini"
      ? "mini"
      : "full"
    : state.window;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.sessionStorage.removeItem(AUTO_REPAIR_SIGNATURE_KEY);
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, []);

  const shell = (
    <div className={`app window-${windowType}`}>
      <ChatStoreProvider>
        <AppBootstrap />
        <ModelPreferencesBridge />
        <PhoneAccessBridge />
        <CredentialRequestLayer />
        {windowType === "mini" ? <MiniShell /> : <FullShell />}
      </ChatStoreProvider>
    </div>
  );

  return (
    <>
      <AuthDeepLinkHandler />
      <Suspense fallback={<div className={`app window-${windowType}`} />}>
        {shell}
      </Suspense>
    </>
  );
}

export { App };
