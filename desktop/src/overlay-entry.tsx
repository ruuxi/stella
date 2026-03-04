import { createRoot } from "react-dom/client";
import "./index.css";
import "./app/overlay/overlays.css";
import "./app/shell/mini/mini-shell.css";
import "./ui/spinner.css";
import "./app/overlay/voice-overlay.css";
import "./ui/code.css";
import "./app/chat/full-shell.chat.css";
import "./app/chat/indicators.css";
import "./app/chat/selfmod-undo.css";
import { ThemeProvider } from "./theme/theme-context";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { UiStateProvider } from "./providers/ui-state";
import { OverlayRoot } from "./app/overlay/OverlayRoot";

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


