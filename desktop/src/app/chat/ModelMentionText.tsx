import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type UIEvent,
} from "react";
import {
  findDelegatedModelMentions,
  type DelegatedModelMentionRange,
} from "../../../../runtime/contracts/model-mentions.js";
import { ComposerTextarea } from "@/features/chat/ComposerPrimitives";
import "./model-mention-text.css";

type ModelMentionTextProps = {
  text: string;
};

/**
 * Renders routing mentions in-place without changing the message text or its
 * whitespace. The same renderer is used by the composer mirror and transcript.
 */
export function ModelMentionText({ text }: ModelMentionTextProps) {
  const mentions = findDelegatedModelMentions(text);
  if (mentions.length === 0) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((mention: DelegatedModelMentionRange) => {
    if (mention.start > cursor) {
      parts.push(text.slice(cursor, mention.start));
    }
    parts.push(
      <span
        key={`${mention.start}:${mention.end}`}
        className="model-mention-inline"
        data-model-route={mention.spawnModel}
      >
        {text.slice(mention.start, mention.end)}
      </span>,
    );
    cursor = mention.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

type ComposerModelMentionTextareaProps = Omit<
  ComponentPropsWithoutRef<typeof ComposerTextarea>,
  "value"
> & {
  value: string;
};

/**
 * Native textareas cannot style a substring. A non-interactive mirror keeps
 * the native editing, selection, IME, and accessibility behavior while adding
 * Slack-style inline mention color underneath the transparent text glyphs.
 */
export const ComposerModelMentionTextarea = forwardRef<
  HTMLTextAreaElement,
  ComposerModelMentionTextareaProps
>(function ComposerModelMentionTextarea(
  { value, className, onScroll, ...props },
  ref,
) {
  const syncMirrorScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const mirror = event.currentTarget.previousElementSibling;
    if (mirror instanceof HTMLElement) {
      mirror.scrollTop = event.currentTarget.scrollTop;
      mirror.scrollLeft = event.currentTarget.scrollLeft;
    }
    onScroll?.(event);
  };

  return (
    <div className="composer-model-mention-field">
      <div
        className={`composer-model-mention-mirror ${className ?? ""}`}
        aria-hidden="true"
      >
        <ModelMentionText text={value} />
        {value.endsWith("\n") && "\u00a0"}
      </div>
      <ComposerTextarea
        ref={ref}
        className={`composer-model-mention-textarea ${className ?? ""}`}
        value={value}
        onScroll={syncMirrorScroll}
        {...props}
      />
    </div>
  );
});
