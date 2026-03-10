import { createRoot } from "react-dom/client";
import "./index.css";
import "./ui/register-styles";
import { ThemeProvider } from "./context/theme-context";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { UiStateProvider } from "./context/ui-state";
import { OverlayRoot } from "./app/overlay/OverlayRoot";
import { DeferredVoiceRuntime } from "./app/voice-runtime/DeferredVoiceRuntime";
import { WakeWordCaptureRoot } from "./app/voice-runtime/WakeWordCaptureRoot";
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
