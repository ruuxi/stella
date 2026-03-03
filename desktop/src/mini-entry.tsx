import { createRoot } from "react-dom/client";
import "./index.css";
import "./components/spinner.css";
import "./components/voice-overlay.css";
import "./components/code.css";
import "./styles/full-shell.chat.css";
import "./styles/mini-shell.css";
import "./styles/indicators.css";
import "./styles/selfmod-undo.css";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UiStateProvider } from "./app/state/ui-state";
import { ThemeProvider } from "./theme/theme-context";
import { MiniShell } from "./screens/MiniShell";

document.documentElement.dataset.stellaWindow = "mini";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <ErrorBoundary>
      <UiStateProvider>
        <div className="app window-mini">
          <MiniShell />
        </div>
      </UiStateProvider>
    </ErrorBoundary>
  </ThemeProvider>,
);
