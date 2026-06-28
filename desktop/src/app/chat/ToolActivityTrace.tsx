/**
 * Inline tool-activity trace.
 *
 * One muted, collapsible summary line per assistant row that ran tools —
 * the Claude-Code-style "Read 3 files and searched code" line with a leading
 * category icon. Click (or Enter/Space) expands it into the individual steps.
 *
 * This is the *settled* record of a turn's tool work. The live, in-flight
 * phase is owned by the footer `WorkingIndicator` (which already narrates the
 * running tool during streaming); the trace only mounts once the row's run
 * has finished (see the `!running` gate in `MessageRow`), so a tool is never
 * shown live and inline at the same time.
 */
import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  Box,
  Check,
  ChevronRight,
  Clock,
  Code,
  FileText,
  Globe,
  Lightbulb,
  MessageSquare,
  Pencil,
  Search,
  Wand2,
} from "@/ui/icons";
import type {
  ToolActivityCategory,
  ToolActivityGroup,
  ToolActivityStep,
} from "@/features/chat/lib/tool-activity";
import "./tool-activity.css";

const CATEGORY_ICON: Record<
  ToolActivityCategory,
  (props: { size?: number; strokeWidth?: number }) => ReactNode
> = {
  read: (props) => <FileText {...props} />,
  edit: (props) => <Pencil {...props} />,
  search: (props) => <Search {...props} />,
  web: (props) => <Globe {...props} />,
  command: (props) => <Code {...props} />,
  create: (props) => <Wand2 {...props} />,
  memory: (props) => <Lightbulb {...props} />,
  schedule: (props) => <Clock {...props} />,
  message: (props) => <MessageSquare {...props} />,
  other: (props) => <Box {...props} />,
};

function CategoryIcon({
  category,
  size = 14,
}: {
  category: ToolActivityCategory;
  size?: number;
}) {
  return CATEGORY_ICON[category]({ size, strokeWidth: 1.75 });
}

function StepRow({ step }: { step: ToolActivityStep }) {
  return (
    <li className="tool-activity__step" data-status={step.status}>
      <span className="tool-activity__step-glyph" aria-hidden="true">
        {step.status === "error" ? (
          <AlertCircle size={12} strokeWidth={2} />
        ) : (
          <Check size={12} strokeWidth={2} />
        )}
      </span>
      <span className="tool-activity__step-icon" aria-hidden="true">
        <CategoryIcon category={step.category} size={12} />
      </span>
      <span className="tool-activity__step-title">{step.title}</span>
    </li>
  );
}

export function ToolActivityTrace({ group }: { group: ToolActivityGroup }) {
  const [expanded, setExpanded] = useState(false);
  const { summary, steps, icon } = group;

  return (
    <div className="tool-activity" data-expanded={expanded ? "true" : undefined}>
      <button
        type="button"
        className="tool-activity__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tool-activity__lead" aria-hidden="true">
          <CategoryIcon category={icon} />
        </span>
        <span className="tool-activity__label">{summary}</span>
        <ChevronRight
          className="tool-activity__chevron"
          size={13}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <ul
          className="tool-activity__steps"
          aria-label={`${steps.length} tool calls`}
        >
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
    </div>
  );
}
