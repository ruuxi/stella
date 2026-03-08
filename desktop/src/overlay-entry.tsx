import { createRoot } from "react-dom/client";
import "./index.css";
import "./ui/register-styles";
import { ThemeProvider } from "./theme/theme-context";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { UiStateProvider } from "./providers/ui-state";
import { OverlayRoot } from "./app/overlay/OverlayRoot";

document.documentElement.dataset.stellaWindow = "overlay";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <UiStateProvider>
      <ErrorBoundary>
        <OverlayRoot />
      </ErrorBoundary>
    </UiStateProvider>
  </ThemeProvider>,
);


