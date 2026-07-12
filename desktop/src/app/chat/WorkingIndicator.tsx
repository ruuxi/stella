import { useUiState } from "@/context/ui-state";
import { useWindowFocus } from "@/shared/hooks/use-window-focus";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { cn } from "@/shared/lib/utils";
import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation";
import { SwapText } from "./SwapText";
import { getWorkingIndicatorDisplayStatus } from "@/features/chat/working-indicator-state";
import "./indicators.css";

interface WorkingIndicatorProps {
  status?: string;
  toolName?: string;
  /** Stable id of the in-flight tool call. Used as a seed for the
   * friendly variation picker so the label doesn't flicker on each
   * re-render. */
  toolCallId?: string;
  isReasoning?: boolean;
  /** Per-turn seed so the reasoning/idle label varies across turns
   * instead of always landing on the first variation ("Thinking"). */
  reasoningSeed?: string;
  className?: string;
}

export function WorkingIndicator({
  status,
  toolName,
  toolCallId,
  isReasoning,
  reasoningSeed,
  className,
}: WorkingIndicatorProps) {
  const { state } = useUiState();
  const windowType = useWindowType();
  const windowFocused = useWindowFocus();
  const animationPaused = !windowFocused || state.window !== windowType;

  const displayStatus = getWorkingIndicatorDisplayStatus({
    status,
    toolName,
    toolCallId,
    isReasoning,
    reasoningSeed,
  });
  return (
    <div className={cn("working-indicator", className)}>
      <div className="indicator-stella">
        <div className="indicator-stella-scale">
          <StellaAnimation
            width={20}
            height={20}
            maxDpr={1}
            frameSkip={2}
            paused={animationPaused}
          />
        </div>
      </div>
      <SwapText
        text={displayStatus}
        active
        animateInitial={false}
        className="working-status"
      />
    </div>
  );
}
