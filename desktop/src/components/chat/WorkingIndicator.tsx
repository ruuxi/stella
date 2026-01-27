import { Spinner } from "../ui/spinner";
import { cn } from "@/lib/utils";

interface WorkingIndicatorProps {
  status?: string;
  duration?: string;
  className?: string;
}

export function WorkingIndicator({
  status = "Considering next steps",
  duration,
  className,
}: WorkingIndicatorProps) {
  return (
    <div className={cn("working-indicator", className)}>
      <Spinner size="sm" />
      <span className="working-status">{status}</span>
      {duration && (
        <>
          <span className="working-separator">{"\u00b7"}</span>
          <span className="working-duration">{duration}</span>
        </>
      )}
    </div>
  );
}
