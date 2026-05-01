import { useEffect } from "react";
import { AuthDeepLinkHandler } from "./global/auth/AuthDeepLinkHandler";
import { PhoneAccessBridge } from "./global/mobile/PhoneAccessBridge";
import { AppBootstrap } from "./systems/boot/AppBootstrap";
import { ChatStoreProvider } from "@/context/chat-store";
import { CredentialRequestLayer } from "./global/auth/CredentialRequestLayer";
import { GoogleWorkspaceAuthListener } from "./global/integrations/GoogleWorkspaceAuthListener";
import { FullShell } from "./shell/FullShell";

const AUTO_REPAIR_SIGNATURE_KEY = "stella:auto-repair:last-signature";

// Every passive IPC listener below mounts eagerly because main fires the
// matching channels fire-and-forget — if the renderer isn't subscribed at the
// moment of `webContents.send(...)`, the event is silently dropped:
//   * CredentialRequestLayer  → `credential:request` (agent stalls 5 min on
//     timeout, see `desktop/electron/services/credential-service.ts`)
//   * GoogleWorkspaceAuthListener → `googleWorkspace:authRequired` (connect
//     card never surfaces, agent's google-workspace tool quietly fails)
// Bundle savings from lazy-loading these were negligible (every dep is in the
// eager chunk anyway), and the cost of missing the event is high.
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
          <PhoneAccessBridge />
          <CredentialRequestLayer />
          <GoogleWorkspaceAuthListener />
          <FullShell />
        </ChatStoreProvider>
      </div>
    </>
  );
}

export { App };
