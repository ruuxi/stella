import { useEffect } from "react";
import { AuthDeepLinkHandler } from "./global/auth/AuthDeepLinkHandler";
import { PhoneAccessBridge } from "./global/mobile/PhoneAccessBridge";
import { AppBootstrap } from "./systems/boot/AppBootstrap";
import { ModelPreferencesBridge } from "@/global/settings/ModelPreferencesBridge";
import { ChatStoreProvider } from "@/context/chat-store";
import { CredentialRequestLayer } from "./global/auth/CredentialRequestLayer";
import { FullShell } from "./shell/FullShell";

const AUTO_REPAIR_SIGNATURE_KEY = "stella:auto-repair:last-signature";

// Everything below mounts eagerly. CredentialRequestLayer in particular MUST
// be in the tree before the agent runtime can fire `RequestCredential`:
// `webContents.send('credential:request', …)` is fire-and-forget on the main
// side, so a lazy boundary here would silently drop credential prompts during
// the boot/post-reload window and stall the agent on its 5-minute timeout
// (see `desktop/electron/services/credential-service.ts`). The actual chunk
// savings were ~5 KB because every dep (`Dialog`, `Button`, `TextField`,
// `useMutation`) is already pulled in by the eager bundle.
function App() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.sessionStorage.removeItem(AUTO_REPAIR_SIGNATURE_KEY);
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <>
      <AuthDeepLinkHandler />
      <div className="app window-full">
        <ChatStoreProvider>
          <AppBootstrap />
          <ModelPreferencesBridge />
          <PhoneAccessBridge />
          <CredentialRequestLayer />
          <FullShell />
        </ChatStoreProvider>
      </div>
    </>
  );
}

export { App };
