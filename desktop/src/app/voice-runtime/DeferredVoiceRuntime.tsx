import { Suspense, lazy, startTransition, useEffect, useState } from "react";

const LazyVoiceRuntimeRoot = lazy(() =>
  import("@/app/voice-runtime/VoiceRuntimeRoot").then((module) => ({
    default: module.VoiceRuntimeRoot,
  })),
);

export function DeferredVoiceRuntime() {
  const [shouldLoadVoiceRuntime, setShouldLoadVoiceRuntime] = useState(false);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      startTransition(() => {
        setShouldLoadVoiceRuntime(true);
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  if (!shouldLoadVoiceRuntime) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <LazyVoiceRuntimeRoot />
    </Suspense>
  );
}
