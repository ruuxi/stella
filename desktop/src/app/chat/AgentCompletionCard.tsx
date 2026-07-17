/**
 * Inline "agent completed" treatment for a spawn-anchored background card.
 *
 * When the matching lifecycle occurrence completes, the original
 * `BackgroundWorkCard` slot switches to this settled presentation. It never
 * creates a second completion-time row.
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
import { useLayoutEffect, useState } from "react";
import { notifyChatContentGrowth } from "@/shell/chat-scroll-follow";
import { Check, ChevronDown, MessageSquare } from "@/ui/icons";
import { DisplayTabIcon } from "@/features/workspace-display/icons";
import {
  openAgentThreadTab,
  openDisplayPayloadTab,
} from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import {
  basenameOf,
  localFilePathForPayload,
} from "@/features/workspace-display/path-to-viewer";
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
  conversationId,
}: {
  section: AgentCompletionSection;
  showHeader: boolean;
  conversationId: string;
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
          <span
            className="agent-completion-card__section-glyph"
            aria-hidden="true"
          >
            <Check size={13} strokeWidth={2} />
          </span>
          <span className="agent-completion-card__section-title">
            {section.title}
          </span>
          <ThreadChatButton section={section} conversationId={conversationId} />
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

const ThreadChatButton = ({
  section,
  conversationId,
}: {
  section: AgentCompletionSection;
  conversationId: string;
}) => (
  <button
    type="button"
    className="agent-completion-card__chat"
    onClick={() =>
      openAgentThreadTab({
        threadId: section.agentId,
        conversationId,
        agentType: section.agentType ?? "Agent",
        title: section.title,
      })
    }
    aria-label={`Open read-only chat for ${section.title}`}
    title="Open read-only chat"
  >
    <MessageSquare size={14} strokeWidth={1.8} aria-hidden="true" />
  </button>
);

export function AgentCompletionCard({
  sections,
  cardId,
  conversationId,
}: {
  sections: AgentCompletionSection[];
  cardId?: string;
  conversationId: string;
}) {
  // The completion card usually replaces the (shorter) spawn card after the
  // run has settled — no stream text notify fires, so tell the scroll
  // surfaces about the growth ourselves. See `notifyChatContentGrowth`.
  useLayoutEffect(() => {
    notifyChatContentGrowth();
  }, []);

  // Every completion renders — a fileless agent still finished its task, so
  // the card must not depend on produced files (files only enrich it).
  const visible = sections;
  if (visible.length === 0) return null;
  const multi = visible.length > 1;
  const startEventIds = visible
    .map((section) => section.startEventId)
    .filter(Boolean);
  const completionEventIds = visible
    .map((section) => section.completionEventId)
    .filter(Boolean);
  const rootRunIds = [
    ...new Set(visible.map((section) => section.rootRunId).filter(Boolean)),
  ];
  const artifactIds = visible.flatMap((section) =>
    section.files.map((entry) => entry.path),
  );

  return (
    <div
      className="agent-completion-card"
      data-multi={multi ? "true" : undefined}
      data-activity-card-id={cardId}
      data-agent-ids={visible.map((section) => section.agentId).join(",")}
      data-start-event-ids={startEventIds.join(",")}
      data-root-run-ids={rootRunIds.join(",")}
      data-terminal-event-ids={completionEventIds.join(",")}
      data-artifact-ids={artifactIds.join(",")}
    >
      {!multi ? (
        <div className="agent-completion-card__head">
          <span className="agent-completion-card__glyph" aria-hidden="true">
            <Check size={14} strokeWidth={2} />
          </span>
          <span className="agent-completion-card__title">
            {visible[0]!.title}
          </span>
          <ThreadChatButton
            section={visible[0]!}
            conversationId={conversationId}
          />
        </div>
      ) : null}
      {visible.map((section) => (
        <CompletionSection
          key={section.startEventId ?? section.agentId}
          section={section}
          showHeader={multi}
          conversationId={conversationId}
        />
      ))}
    </div>
  );
}
