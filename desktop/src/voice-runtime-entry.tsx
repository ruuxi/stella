import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { VoiceRuntimeRoot } from "./app/voice-runtime/VoiceRuntimeRoot";
import { UiStateProvider } from "./providers/ui-state";

document.documentElement.dataset.stellaWindow = "voice-runtime";

createRoot(document.getElementById("root")!).render(
  <UiStateProvider>
    <ErrorBoundary>
      <VoiceRuntimeRoot />
    </ErrorBoundary>
  </UiStateProvider>,
);
