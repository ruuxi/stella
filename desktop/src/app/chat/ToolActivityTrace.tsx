/**
 * Inline tool-activity trace.
 *
 * One muted, collapsible summary line per assistant row that ran tools —
 * the Claude-Code-style "Read 3 files and searched code" line with a leading
 * category icon. Click (or Enter/Space) expands it into the individual steps.
 *
 * This is the *settled* record of a turn's tool work (only completed calls are
 * counted). The live, in-flight call is owned by the footer `WorkingIndicator`.
 *
 * Motion:
 *  - the line eases in the first time it appears (once per row — a module
 *    `Set` keyed by `traceKey` suppresses the replay when a virtualized row
 *    recycles on scroll);
 *  - the summary crossfades when its text changes (e.g. count 1 → 2), via the
 *    same keyed-layer swap the working indicator uses;
 *  - expand/collapse animates the step list's `height` between 0 and its
 *    measured pixel height (a fixed-px range the browser interpolates
 *    smoothly), then releases to `auto`. The grid `0fr ↔ 1fr` trick reads as
 *    stepping inside the virtualized list, which re-measures the row per frame.
 * All of it is disabled under `prefers-reduced-motion`.
 */
import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

const SWAP_DURATION_MS = 240;

/**
 * Crossfade between summary strings when `text` changes — a trimmed copy of
 * `SwapText` without the shimmer wrapper (this line is settled, not live).
 */
function SwapLabel({ text }: { text: string }) {
  const [current, setCurrent] = useState(text);
  const [previous, setPrevious] = useState<string | null>(null);
  const lastTextRef = useRef(text);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (text === lastTextRef.current) return;
    setPrevious(lastTextRef.current);
    setCurrent(text);
    lastTextRef.current = text;
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      setPrevious(null);
      timeoutRef.current = null;
    }, SWAP_DURATION_MS);
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [text]);

  return (
    <span className="tool-activity__swap">
      {previous !== null && (
        <span
          key={`out:${previous}`}
          className="tool-activity__swap-layer tool-activity__swap-layer--out"
          aria-hidden="true"
        >
          {previous}
        </span>
      )}
      <span
        key={`in:${current}`}
        className="tool-activity__swap-layer tool-activity__swap-layer--in"
      >
        {current}
      </span>
    </span>
  );
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

// Trace keys whose intro animation has already played, so a virtualized row
// recycling back into view doesn't re-run the enter animation.
const introPlayed = new Set<string>();

export function ToolActivityTrace({
  group,
  traceKey,
}: {
  group: ToolActivityGroup;
  traceKey: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { summary, steps, icon } = group;

  // Play the intro only on the first appearance of this row's trace.
  const [intro] = useState(() => !introPlayed.has(traceKey));
  useEffect(() => {
    introPlayed.add(traceKey);
  }, [traceKey]);

  // Measured-height accordion: animate `height` between 0 and the content's
  // pixel height, then release to `auto` so later count tick-ups (while open)
  // grow naturally. Animating fixed-px endpoints stays smooth where the grid
  // `fr` trick stutters under the list's per-frame re-measure.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLUListElement | null>(null);
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;

    // No animation on first mount (or when the user opts out of motion) —
    // just settle to the resting height.
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (!mountedRef.current || reduce) {
      mountedRef.current = true;
      wrap.style.height = expanded ? "auto" : "0px";
      return;
    }

    if (expanded) {
      const target = inner.offsetHeight;
      wrap.style.height = "0px";
      void wrap.offsetHeight; // commit the 0 start before transitioning
      wrap.style.height = `${target}px`;
      const onEnd = (event: TransitionEvent) => {
        if (event.propertyName !== "height") return;
        wrap.style.height = "auto"; // let it grow with later steps
        wrap.removeEventListener("transitionend", onEnd);
      };
      wrap.addEventListener("transitionend", onEnd);
      return () => wrap.removeEventListener("transitionend", onEnd);
    }

    // Collapsing: pin the current height in px, then transition to 0.
    wrap.style.height = `${inner.offsetHeight}px`;
    void wrap.offsetHeight;
    wrap.style.height = "0px";
    // Only re-run on open/close — while open the height is `auto`, so later
    // step tick-ups grow the list naturally without replaying the animation.
  }, [expanded]);

  return (
    <div
      className={`tool-activity${intro ? " tool-activity--intro" : ""}`}
      data-expanded={expanded ? "true" : undefined}
    >
      <button
        type="button"
        className="tool-activity__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tool-activity__lead" aria-hidden="true">
          <CategoryIcon category={icon} />
        </span>
        <span className="tool-activity__label">
          <SwapLabel text={summary} />
        </span>
        <ChevronRight
          className="tool-activity__chevron"
          size={13}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
      <div
        className="tool-activity__steps-wrap"
        ref={wrapRef}
        aria-hidden={!expanded}
      >
        <ul
          className="tool-activity__steps"
          ref={innerRef}
          aria-label={`${steps.length} tool calls`}
        >
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      </div>
    </div>
  );
}
