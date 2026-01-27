import { Spinner } from "../ui/spinner";
import { cn } from "@/lib/utils";
import { computeStatus } from "./status-utils";

interface WorkingIndicatorProps {
  status?: string;
  toolName?: string;
  isReasoning?: boolean;
  isResponding?: boolean;
  duration?: string;
  className?: string;
}

export function WorkingIndicator({
  status,
  toolName,
  isReasoning,
  isResponding,
  duration,
  className,
}: WorkingIndicatorProps) {
  // Use explicit status if provided, otherwise compute from context
  const displayStatus = status ?? computeStatus({ toolName, isReasoning, isResponding });

  return (
    <div className={cn("working-indicator", className)}>
      <Spinner size="sm" />
      <span className="working-status">{displayStatus}</span>
      {duration && (
        <>
          <span className="working-separator">{"\u00b7"}</span>
          <span className="working-duration">{duration}</span>
        </>
      )}
    </div>
  );
}
