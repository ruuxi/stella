import { createRoot } from "react-dom/client";
import "./index.css";
import "./ui/register-styles";
import { ThemeProvider } from "./context/theme-context";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { UiStateProvider } from "./context/ui-state";
import { OverlayRoot } from "./shell/overlay/OverlayRoot";
import { DeferredVoiceRuntime } from "./systems/voice/DeferredVoiceRuntime";
import { WakeWordCaptureRoot } from "./systems/voice/WakeWordCaptureRoot";
import { ToastProvider } from "./ui/toast";

document.documentElement.dataset.stellaWindow = "overlay";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <ToastProvider>
      <UiStateProvider>
        <ErrorBoundary>
          <DeferredVoiceRuntime />
          <WakeWordCaptureRoot />
          <OverlayRoot />
        </ErrorBoundary>
      </UiStateProvider>
    </ToastProvider>
  </ThemeProvider>,
);

