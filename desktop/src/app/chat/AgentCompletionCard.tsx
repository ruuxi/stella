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
import { useState } from "react";
import { Check, ChevronDown } from "@/ui/icons";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import { basenameOf, localFilePathForPayload } from "@/features/workspace-display/path-to-viewer";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
import { Markdown } from "./Markdown";
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
  const total = section.files.length;
  const capped = total > PILL_CAP;
  const head = capped ? section.files.slice(0, PILL_CAP) : section.files;
  const rest = capped ? section.files.slice(PILL_CAP) : [];
  const hiddenCount = rest.length;

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
      {total > 0 ? (
        <div className="agent-completion-card__pills">
          {head.map((entry) => (
            <FilePill key={entry.path} entry={entry} />
          ))}
        </div>
      ) : section.summary ? (
        // Fileless completion: the result excerpt stands in for the pills so
        // the card still shows what the agent accomplished. Rendered through
        // the chat markdown pipeline (the excerpt is inline-only markdown —
        // block constructs are stripped at derivation) so `**bold**` /
        // `` `code` `` read as formatting, not literals.
        <div className="agent-completion-card__summary">
          <Markdown
            text={section.summary}
            cacheKey={`agent-completion-summary:${section.agentId}:${section.completedAtMs}`}
          />
        </div>
      ) : null}
      {capped ? (
        // Animated reveal via `grid-template-rows: 0fr -> 1fr` — no JS
        // measurement, stays correct across width changes / re-wraps.
        // `inert` while collapsed keeps the hidden pills out of the tab
        // order and away from screen readers.
        <div
          className="agent-completion-card__overflow"
          data-expanded={expanded ? "true" : undefined}
          inert={expanded ? undefined : true}
        >
          <div className="agent-completion-card__overflow-clip">
            <div className="agent-completion-card__pills agent-completion-card__pills--overflow">
              {rest.map((entry) => (
                <FilePill key={entry.path} entry={entry} />
              ))}
            </div>
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
  // Every completion renders — a fileless agent still finished its task, so
  // the card must not depend on produced files (files only enrich it).
  const visible = sections;
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
