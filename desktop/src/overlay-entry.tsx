import { createRoot } from "react-dom/client";
import "./index.css";
import "./ui/register-styles";
import { ThemeProvider } from "./context/theme-context";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { UiStateProvider } from "./context/ui-state";
import { OverlayRoot } from "./app/overlay/OverlayRoot";
import { VoiceRuntimeRoot } from "./app/voice-runtime/VoiceRuntimeRoot";

document.documentElement.dataset.stellaWindow = "overlay";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <UiStateProvider>
      <ErrorBoundary>
        <VoiceRuntimeRoot />
        <OverlayRoot />
      </ErrorBoundary>
    </UiStateProvider>
  </ThemeProvider>,
);


