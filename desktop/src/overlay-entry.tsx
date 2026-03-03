import { createRoot } from "react-dom/client";
import "./index.css";
import "./styles/overlays.css";
import "./styles/mini-shell.css";
import "./components/spinner.css";
import "./components/voice-overlay.css";
import "./components/code.css";
import "./styles/full-shell.chat.css";
import "./styles/indicators.css";
import "./styles/selfmod-undo.css";
import { ThemeProvider } from "./theme/theme-context";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UiStateProvider } from "./app/state/ui-state";
import { OverlayRoot } from "./screens/OverlayRoot";

document.documentElement.dataset.stellaWindow = "overlay";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <ErrorBoundary>
      <UiStateProvider>
        <OverlayRoot />
      </UiStateProvider>
    </ErrorBoundary>
  </ThemeProvider>,
);
