/**
 * The above-composer lead row shared by every chat composer surface (full
 * shell + sidebar/wide panel). It stacks the optional assistant reply peek
 * over a row of the activity/search pill and the auto-context suggestion
 * chips.
 *
 * Keeping this in one place is deliberate: the row used to be duplicated in
 * the full-shell `Composer` and the sidebar `ChatPanelTab`, which is how the
 * `ComposerActivityPill` (and its progress summaries) drifted onto one surface
 * but not the other. Surfaces that have no `ChatRuntimeProvider` — namely the
 * mini window — pass `showActivityPill={false}`, since the pill reads the
 * shared runtime.
 */

import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import {
  AssistantReplyPeek,
  type AssistantReplyPeekProps,
} from "@/app/chat/AssistantReplyPeek";
import { ComposerActivityPill } from "@/app/chat/ComposerActivityPill";
import { ComposerSuggestionContextRow } from "@/app/chat/ComposerContextRow";

type ComposerLeadRowProps = {
  /** When present, the assistant reply peek renders flush above the row. */
  replyPeek?: AssistantReplyPeekProps | null;
  /** Pill is gated off where there's no chat runtime (the mini window). */
  showActivityPill: boolean;
  suggestionsActive: boolean;
  chatContext: ChatContext | null;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
};

export function ComposerLeadRow({
  replyPeek,
  showActivityPill,
  suggestionsActive,
  chatContext,
  setChatContext,
}: ComposerLeadRowProps) {
  return (
    <div className="composer-context-peek-anchor">
      {replyPeek ? <AssistantReplyPeek {...replyPeek} /> : null}
      <div className="composer-context-lead-row">
        {showActivityPill ? <ComposerActivityPill /> : null}
        <ComposerSuggestionContextRow
          active={suggestionsActive}
          chatContext={chatContext}
          setChatContext={setChatContext}
        />
      </div>
    </div>
  );
}
