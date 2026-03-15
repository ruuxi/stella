const stripScriptTags = (html: string): string =>
  html.replace(/<script\b[\s\S]*?<\/script>/gi, "");

export const createDisplayStreamController = (
  displayHtml?: (html: string) => void,
) => {
  let displayStreamTimer: ReturnType<typeof setTimeout> | null = null;
  let displayStreamLastHtml = "";

  const handleEvent = (event: {
    type?: string;
    assistantMessageEvent?: {
      type?: string;
      partial?: { content?: Array<unknown> };
      contentIndex?: number;
    };
  }): boolean => {
    if (
      !displayHtml ||
      event.type !== "message_update" ||
      event.assistantMessageEvent?.type !== "toolcall_delta"
    ) {
      return false;
    }

    try {
      const partial = event.assistantMessageEvent.partial;
      const contentIndex = event.assistantMessageEvent.contentIndex;
      const block = partial?.content?.[contentIndex ?? -1] as
        | {
            type?: string;
            name?: string;
            arguments?: Record<string, unknown>;
          }
        | undefined;
      if (
        block?.type === "toolCall" &&
        block.name === "Display" &&
        typeof block.arguments?.html === "string"
      ) {
        const html = stripScriptTags(block.arguments.html);
        if (html.length > 20 && html !== displayStreamLastHtml) {
          displayStreamLastHtml = html;
          if (!displayStreamTimer) {
            displayStreamTimer = setTimeout(() => {
              displayStreamTimer = null;
              if (displayStreamLastHtml && displayHtml) {
                displayHtml(displayStreamLastHtml);
              }
            }, 150);
          }
        }
      }
    } catch {
      // Ignore partial JSON parsing errors during Display streaming.
    }

    return true;
  };

  const flush = () => {
    if (displayStreamTimer) {
      clearTimeout(displayStreamTimer);
      displayStreamTimer = null;
    }
    if (displayStreamLastHtml && displayHtml) {
      displayHtml(displayStreamLastHtml);
    }
  };

  const dispose = () => {
    if (displayStreamTimer) {
      clearTimeout(displayStreamTimer);
      displayStreamTimer = null;
    }
  };

  return {
    handleEvent,
    flush,
    dispose,
  };
};
