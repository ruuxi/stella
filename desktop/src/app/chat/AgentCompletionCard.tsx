/**
 * Inline "agent completed" card — the quiet "done + files" surface anchored to
 * the transcript position where a delegated agent's work finished.
 *
 * Pairs with `BackgroundWorkCard` (the spawn/working breadcrumb that stays at
 * the spawn point): when the agent COMPLETES, this card appears at the
 * `agent-completed` event's chronological position so the user sees the
 * finished work in place, without scrolling back to the spawn.
 *
 * Design:
 *   - Understated done treatment — a muted checkmark glyph + calm title, no
 *     colored status badge, no shimmer.
 *   - Each produced file is a pill: [file-type icon] + filename + a compact
 *     "+" affordance. Clicking the pill body opens the file
 *     (`openDisplayPayloadTab`, exactly like the sidebar `TaskRow` and
 *     `EndResourceCard`); the "+" opens the shared `OpenWithMenu` ("open in
 *     other ways").
 *   - Several agents completing at the same point stay sectionalized — one
 *     header + its own pills per agent, never merged into one flat list.
 *   - At most 5 pills per section, then an animated "+N more" expand/collapse.
 */
import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "@/ui/icons";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import { basenameOf, localFilePathForPayload } from "@/features/workspace-display/path-to-viewer";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
import { OpenWithMenu } from "./OpenWithMenu";
import "./agent-completion-card.css";

/** Pills shown before the "+N more" control kicks in. */
const PILL_CAP = 5;

const FilePill = ({ entry }: { entry: ConversationFileEntry }) => {
  const localFilePath = localFilePathForPayload(entry.payload);
  return (
    <span className="agent-completion-card__pill" title={entry.path}>
      <button
        type="button"
        className="agent-completion-card__pill-open"
        onClick={() => openDisplayPayloadTab(entry.payload)}
      >
        <span className="agent-completion-card__pill-icon" aria-hidden="true">
          <DisplayTabIcon
            kind={displayTabKindForPayload(entry.payload)}
            size={15}
          />
        </span>
        <span className="agent-completion-card__pill-name">
          {basenameOf(entry.path)}
        </span>
      </button>
      {localFilePath ? (
        <OpenWithMenu filePath={localFilePath} variant="plus" />
      ) : null}
    </span>
  );
};

const CompletionSection = ({
  section,
  showHeader,
}: {
  section: AgentCompletionSection;
  showHeader: boolean;
}) => {
  const [expanded, setExpanded] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const total = section.files.length;
  const capped = total > PILL_CAP;
  const head = capped ? section.files.slice(0, PILL_CAP) : section.files;
  const rest = capped ? section.files.slice(PILL_CAP) : [];
  const hiddenCount = rest.length;

  // Animate the overflow region by transitioning its max-height between 0 and
  // its measured scroll height (an explicit pixel target so the ease works —
  // `max-height: none` can't be transitioned).
  const overflowMaxHeight = useMemo(() => {
    if (!expanded) return 0;
    return overflowRef.current?.scrollHeight ?? 9999;
  }, [expanded]);

  return (
    <div className="agent-completion-card__section">
      {showHeader ? (
        <div className="agent-completion-card__section-head">
          <span className="agent-completion-card__section-glyph" aria-hidden="true">
            <Check size={13} strokeWidth={2} />
          </span>
          <span className="agent-completion-card__section-title">
            {section.title}
          </span>
        </div>
      ) : null}
      <div className="agent-completion-card__pills">
        {head.map((entry) => (
          <FilePill key={entry.path} entry={entry} />
        ))}
      </div>
      {capped ? (
        <div
          ref={overflowRef}
          className="agent-completion-card__overflow"
          data-expanded={expanded ? "true" : undefined}
          style={{ maxHeight: overflowMaxHeight }}
        >
          <div className="agent-completion-card__pills">
            {rest.map((entry) => (
              <FilePill key={entry.path} entry={entry} />
            ))}
          </div>
        </div>
      ) : null}
      {capped ? (
        <button
          type="button"
          className="agent-completion-card__more"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <ChevronDown
            size={13}
            strokeWidth={2}
            aria-hidden
            className="agent-completion-card__more-chevron"
            data-expanded={expanded ? "true" : undefined}
          />
          <span>{expanded ? "Show less" : `+${hiddenCount} more`}</span>
        </button>
      ) : null}
    </div>
  );
};

export function AgentCompletionCard({
  sections,
}: {
  sections: AgentCompletionSection[];
}) {
  const visible = sections.filter((section) => section.files.length > 0);
  if (visible.length === 0) return null;
  const multi = visible.length > 1;

  return (
    <div className="agent-completion-card" data-multi={multi ? "true" : undefined}>
      {!multi ? (
        <div className="agent-completion-card__head">
          <span className="agent-completion-card__glyph" aria-hidden="true">
            <Check size={14} strokeWidth={2} />
          </span>
          <span className="agent-completion-card__title">
            {visible[0]!.title}
          </span>
        </div>
      ) : null}
      {visible.map((section) => (
        <CompletionSection
          key={section.agentId}
          section={section}
          showHeader={multi}
        />
      ))}
    </div>
  );
}
