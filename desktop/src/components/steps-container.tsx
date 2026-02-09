import * as React from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";
import { ChevronsUpDown } from "lucide-react";

export interface StepItem {
  id: string;
  tool: string;
  title?: string;
  subtitle?: string;
  status: "pending" | "running" | "completed" | "error";
}

export interface StepsContainerProps {
  steps: StepItem[];
  expanded?: boolean;
  working?: boolean;
  status?: string;
  duration?: string;
  className?: string;
  onToggle?: () => void;
}

type ToolMeta = {
  icon: string;
  label: string;
};

const TOOL_META: Record<string, ToolMeta> = {
  read: { icon: "📖", label: "Read" },
  write: { icon: "✏️", label: "Write" },
  edit: { icon: "✏️", label: "Edit" },
  grep: { icon: "🔍", label: "Search" },
  glob: { icon: "🔍", label: "Find files" },
  list: { icon: "🔍", label: "List" },
  bash: { icon: "⌨️", label: "Terminal" },
  killshell: { icon: "⌨️", label: "Kill Shell" },
  webfetch: { icon: "🌐", label: "Fetch" },
  task: { icon: "🤖", label: "Task" },
  taskcreate: { icon: "🤖", label: "Task" },
  taskoutput: { icon: "🤖", label: "Task Output" },
  taskcancel: { icon: "🤖", label: "Task Cancel" },
  heartbeatget: { icon: "⏰", label: "Heartbeat" },
  heartbeatupsert: { icon: "⏰", label: "Heartbeat" },
  heartbeatrun: { icon: "⏰", label: "Heartbeat" },
  cronlist: { icon: "⏰", label: "Schedule" },
  cronadd: { icon: "⏰", label: "Schedule" },
  cronupdate: { icon: "⏰", label: "Schedule" },
  cronremove: { icon: "⏰", label: "Schedule" },
  cronrun: { icon: "⏰", label: "Schedule" },
};

const resolveToolMeta = (tool: string): ToolMeta => {
  const lower = tool.toLowerCase();
  return TOOL_META[lower] ?? { icon: "🔧", label: tool };
};

function StepItemDisplay({ step, hideDetails }: { step: StepItem; hideDetails?: boolean }) {
  const toolMeta = resolveToolMeta(step.tool);

  return (
    <div data-slot="step-item" data-status={step.status}>
      <div data-slot="step-item-icon">{toolMeta.icon}</div>
      <div data-slot="step-item-content">
        <span data-slot="step-item-tool">{toolMeta.label}</span>
        {!hideDetails && step.title && (
          <span data-slot="step-item-title">{step.title}</span>
        )}
        {!hideDetails && step.subtitle && (
          <span data-slot="step-item-subtitle">{step.subtitle}</span>
        )}
      </div>
      {step.status === "running" && (
        <div data-slot="step-item-spinner">
          <Spinner />
        </div>
      )}
      {step.status === "completed" && (
        <span data-slot="step-item-check">✓</span>
      )}
      {step.status === "error" && (
        <span data-slot="step-item-error">✗</span>
      )}
    </div>
  );
}

export function StepsContainer({
  steps,
  expanded = false,
  working = false,
  className,
  onToggle,
}: StepsContainerProps) {
  const [animatingIndex, setAnimatingIndex] = React.useState<number | null>(null);
  const prevLengthRef = React.useRef(0);

  React.useEffect(() => {
    const currentLength = steps.length;
    const prev = prevLengthRef.current;

    if (currentLength > prev && prev > 0) {
      setAnimatingIndex(currentLength - 1);
      const timeout = setTimeout(() => setAnimatingIndex(null), 300);
      return () => clearTimeout(timeout);
    }

    prevLengthRef.current = currentLength;
  }, [steps.length]);

  const visibleSteps = React.useMemo(() => {
    if (steps.length === 0) return [];
    if (expanded) return steps;
    if (steps.length <= 3) return steps;
    return steps.slice(-3);
  }, [steps, expanded]);

  return (
    <div
      data-component="steps-container"
      data-expanded={expanded}
      className={cn(className)}
    >
      <div data-slot="steps-track" data-animating={animatingIndex !== null}>
        {visibleSteps.map((step, index) => {
          const isNew = animatingIndex !== null && index === visibleSteps.length - 1;
          const isLast = index === visibleSteps.length - 1;

          return (
            <div
              key={step.id}
              data-slot="steps-item"
              data-new={isNew}
              data-last={isLast}
            >
              <StepItemDisplay step={step} hideDetails={!expanded} />
            </div>
          );
        })}
      </div>

      <div data-slot="steps-footer" onClick={onToggle}>
        {working && !expanded && <Spinner />}
        <span>{expanded ? "Hide" : `Steps ${steps.length}+`}</span>
        <ChevronsUpDown size={14} />
      </div>
    </div>
  );
}
