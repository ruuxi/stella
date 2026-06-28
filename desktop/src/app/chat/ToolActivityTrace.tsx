/**
 * Inline tool-activity trace.
 *
 * One muted, collapsible summary line per assistant row that ran tools —
 * the Claude-Code-style "Read 3 files and searched code" line with a leading
 * category icon. Click (or Enter/Space) expands it into the individual steps.
 *
 * While the turn is still streaming the group reports a running step, so the
 * line shows a live label ("Reading MessageRow.tsx") with a shimmer; when the
 * response finalizes the running step resolves and the line settles into the
 * static summary — that settle IS the "collapse when finalized" behavior.
 */
import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Code,
  FileText,
  Globe,
  LoaderCircle,
  Pencil,
  Search,
  Box,
} from "@/ui/icons";
import { TextShimmer } from "@/app/chat/TextShimmer";
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
  code: (props) => <Code {...props} />,
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
        {step.status === "running" ? (
          <LoaderCircle size={12} strokeWidth={2} className="tool-activity__spin" />
        ) : step.status === "error" ? (
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
  const { running, summary, runningLabel, steps, icon } = group;

  const label = running ? (runningLabel ?? summary) : summary;
  const stepCount = steps.length;

  return (
    <div
      className="tool-activity"
      data-state={running ? "running" : "done"}
      data-expanded={expanded ? "true" : undefined}
    >
      <button
        type="button"
        className="tool-activity__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tool-activity__lead" aria-hidden="true">
          {running ? (
            <LoaderCircle
              size={14}
              strokeWidth={2}
              className="tool-activity__spin"
            />
          ) : (
            <CategoryIcon category={icon} />
          )}
        </span>
        <span className="tool-activity__label">
          {running ? (
            <TextShimmer text={label} durationMs={1900} />
          ) : (
            label
          )}
        </span>
        <ChevronRight
          className="tool-activity__chevron"
          size={13}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <ul className="tool-activity__steps" aria-label={`${stepCount} tool calls`}>
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
    </div>
  );
}
