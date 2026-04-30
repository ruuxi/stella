import { useEffect, useState } from "react";
import { useUiState } from "@/context/ui-state";
import { useWindowFocus } from "@/shared/hooks/use-window-focus";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { cn } from "@/shared/lib/utils";
import type { TaskItem } from "@/app/chat/lib/event-transforms";
import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation";
import { TextShimmer } from "./TextShimmer";
import { getWorkingIndicatorDisplayStatus } from "./working-indicator-state";
import "./indicators.css";

interface WorkingIndicatorProps {
  status?: string;
  toolName?: string;
  tasks?: TaskItem[];
  isReasoning?: boolean;
  className?: string;
}

export function WorkingIndicator({
  status,
  toolName,
  tasks,
  isReasoning,
  className,
}: WorkingIndicatorProps) {
  const { state } = useUiState();
  const windowType = useWindowType();
  const windowFocused = useWindowFocus();
  const animationPaused = !windowFocused || state.window !== windowType;

  // Defer StellaAnimation mount so WebGL shader compilation doesn't block
  // the first streaming frames. The text status renders immediately.
  const [animReady, setAnimReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const activeTask = tasks?.[0];
  const shimmerActive = !activeTask || activeTask.status === "running";
  const displayStatus = getWorkingIndicatorDisplayStatus({
    status,
    toolName,
    tasks,
    isReasoning,
  });

  return (
    <div className={cn("working-indicator", className)}>
      <div className="indicator-stella">
        <div className="indicator-stella-scale">
          {animReady && (
            <StellaAnimation
              width={20}
              height={20}
              maxDpr={1}
              frameSkip={2}
              paused={animationPaused}
            />
          )}
        </div>
      </div>
      <TextShimmer
        text={displayStatus}
        active={shimmerActive}
        className="working-status"
      />
    </div>
  );
}
