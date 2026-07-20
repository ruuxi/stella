import type { ComponentProps } from "react";
import type { TaskLifecycleStatus } from "../../../../../runtime/contracts/agent-runtime.js";
import { AlertCircle, CheckCircle2, Circle, CircleDot } from "@/ui/icons";

type StatusIconProps = Omit<ComponentProps<typeof CircleDot>, "ref"> & {
  status: TaskLifecycleStatus;
};

/** One icon vocabulary for inline cards and Activity rows. */
export function AgentLifecycleStatusIcon({
  status,
  ...props
}: StatusIconProps) {
  switch (status) {
    case "running":
      return <CircleDot {...props} />;
    case "completed":
      return <CheckCircle2 {...props} />;
    case "error":
      return <AlertCircle {...props} />;
    case "canceled":
      return <Circle {...props} />;
  }
}
