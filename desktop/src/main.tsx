import "@vitejs/plugin-react/preamble";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./ui/register-styles";
import "./shared/styles/app-base.css";
import "./shared/styles/app-components.css";
import "./shared/i18n/rtl.css";

import "./platform/dev/vite-error-recovery";
import "./shared/lib/interface-preferences";
import { applyLowPowerDocumentFlag } from "./shared/lib/device-perf";
import "./shared/lib/native-font-smoothing";

applyLowPowerDocumentFlag();
import { installRendererErrorReporting } from "./platform/diagnostics/report-error";
import { App } from "./App.tsx";
import { AppProviders } from "./context/AppProviders";
import { DesktopConvexAuthProvider } from "./global/auth/DesktopConvexAuthProvider";
import { ErrorBoundary } from "./shell/ErrorBoundary";

installRendererErrorReporting();

const requestedWindow = new URLSearchParams(window.location.search).get(
  "window",
);
const isMiniWindow = requestedWindow === "mini";
document.documentElement.dataset.stellaWindow = isMiniWindow ? "mini" : "full";

const appTree = (
  <ErrorBoundary>
    <DesktopConvexAuthProvider enableRuntimeEffects={!isMiniWindow}>
      <AppProviders>
        <App />
      </AppProviders>
    </DesktopConvexAuthProvider>
  </ErrorBoundary>
);

createRoot(document.getElementById("root")!).render(appTree);
