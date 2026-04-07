import { Suspense, lazy, useEffect } from "react";
import { AuthDeepLinkHandler } from "./global/auth/AuthDeepLinkHandler";
import { PhoneAccessBridge } from "./global/mobile/PhoneAccessBridge";
import { AppBootstrap } from "./systems/boot/AppBootstrap";
import { ModelPreferencesBridge } from "@/global/settings/ModelPreferencesBridge";
import { ChatStoreProvider } from "@/context/chat-store";

const AUTO_REPAIR_SIGNATURE_KEY = "stella:auto-repair:last-signature";
const CredentialRequestLayer = lazy(() =>
  import("./global/auth/CredentialRequestLayer").then((module) => ({
    default: module.CredentialRequestLayer,
  })),
);
const FullShell = lazy(() =>
  import("./shell/FullShell").then((module) => ({ default: module.FullShell })),
);

function App() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.sessionStorage.removeItem(AUTO_REPAIR_SIGNATURE_KEY);
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, []);

  const shell = (
    <div className="app window-full">
      <ChatStoreProvider>
        <AppBootstrap />
        <ModelPreferencesBridge />
        <PhoneAccessBridge />
        <CredentialRequestLayer />
        <FullShell />
      </ChatStoreProvider>
    </div>
  );

  return (
    <>
      <AuthDeepLinkHandler />
      <Suspense fallback={<div className="app window-full" />}>
        {shell}
      </Suspense>
    </>
  );
}

export { App };
