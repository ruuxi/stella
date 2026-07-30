/**
 * The above-composer lead row shared by every chat composer surface (full
 * shell + sidebar/wide panel). It stacks the optional assistant reply peek
 * over the conditional Activity pill.
 *
 * Keeping this in one place is deliberate: the row used to be duplicated in
 * the full-shell `Composer` and the sidebar `ChatPanelTab`, which is how the
 * `ComposerActivityPill` drifted onto one surface but not the other.
 * Surfaces without `ChatRuntimeProvider` pass
 * `showActivityPill={false}`, since the pill reads the shared runtime.
 * The pill stands down while the standalone Activity surface is visible and
 * returns when the right sidebar or a narrow-width breakpoint hides it.
 */

import {
  AssistantReplyPeek,
  type AssistantReplyPeekProps,
} from "@/app/chat/AssistantReplyPeek";
import { ComposerActivityPill } from "@/app/chat/ComposerActivityPill";

type ComposerLeadRowProps = {
  /** When present, the assistant reply peek renders flush above the row. */
  replyPeek?: AssistantReplyPeekProps | null;
  /** Pill is gated off where there is no chat runtime. */
  showActivityPill?: boolean;
};

export function ComposerLeadRow({
  replyPeek,
  showActivityPill = false,
}: ComposerLeadRowProps) {
  return (
    <div className="composer-context-peek-anchor">
      {replyPeek ? <AssistantReplyPeek {...replyPeek} /> : null}
      <div className="composer-context-lead-row">
        {showActivityPill ? <ComposerActivityPill /> : null}
      </div>
    </div>
  );
}
