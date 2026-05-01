import "@vitejs/plugin-react/preamble";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./ui/register-styles";
import "./shared/styles/app-base.css";
import "./shared/styles/app-components.css";
import "./shared/i18n/rtl.css";

import "./platform/dev/vite-error-recovery";
import { App } from "./App.tsx";
import { AppProviders } from "./context/AppProviders";
import { DesktopConvexAuthProvider } from "./global/auth/DesktopConvexAuthProvider";
import { initStellaUiHandler } from "./platform/electron/stella-ui-handler";
import { ErrorBoundary } from "./shell/ErrorBoundary";
initStellaUiHandler()

const requestedWindow = new URLSearchParams(window.location.search).get("window");
document.documentElement.dataset.stellaWindow =
  requestedWindow === "mini" ? "mini" : "full";

const appTree = (
  <ErrorBoundary>
    <DesktopConvexAuthProvider>
      <AppProviders>
        <App />
      </AppProviders>
    </DesktopConvexAuthProvider>
  </ErrorBoundary>
);

createRoot(document.getElementById("root")!).render(appTree);
