/**
 * The above-composer lead row shared by every chat composer surface (full
 * shell + sidebar/wide panel). It stacks the optional assistant reply peek
 * over a row of the auto-context suggestion chips.
 *
 * Keeping this in one place is deliberate: the row used to be duplicated in
 * the full-shell `Composer` and the sidebar `ChatPanelTab`, which is how
 * surface-specific chrome drifted onto one surface but not the other.
 */

import type { Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import {
  AssistantReplyPeek,
  type AssistantReplyPeekProps,
} from "@/app/chat/AssistantReplyPeek";
import { ComposerSuggestionContextRow } from "@/app/chat/ComposerContextRow";

type ComposerLeadRowProps = {
  /** When present, the assistant reply peek renders flush above the row. */
  replyPeek?: AssistantReplyPeekProps | null;
  suggestionsActive: boolean;
  chatContext: ChatContext | null;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
};

export function ComposerLeadRow({
  replyPeek,
  suggestionsActive,
  chatContext,
  setChatContext,
}: ComposerLeadRowProps) {
  return (
    <div className="composer-context-peek-anchor">
      {replyPeek ? <AssistantReplyPeek {...replyPeek} /> : null}
      <div className="composer-context-lead-row">
        <ComposerSuggestionContextRow
          active={suggestionsActive}
          chatContext={chatContext}
          setChatContext={setChatContext}
        />
      </div>
    </div>
  );
}
