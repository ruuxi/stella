import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DESKTOP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(DESKTOP_ROOT, relativePath), "utf8");

describe("chat scroll performance contract", () => {
  it("does not enable Legend's forced-geometry onScroll adapter", () => {
    const timeline = readSource("src/app/chat/ChatTimeline.tsx");
    const social = readSource("src/app/social/SocialChatPane.tsx");

    expect(timeline).not.toContain("onScroll={onListScroll}");
    expect(social).not.toContain("onScroll={socialScroll.onListScroll}");
  });

  it("tracks scroll state from a passive native listener instead", () => {
    const hook = readSource("src/shell/use-chat-scroll-management.ts");

    expect(hook).toContain(
      "node.addEventListener('scroll', scheduleScrollStateUpdate, {",
    );
    expect(hook).toMatch(
      /addEventListener\('scroll', scheduleScrollStateUpdate, \{\s*passive: true,/,
    );
    expect(hook).toContain(
      "attached.removeEventListener('scroll', scheduleScrollStateUpdate)",
    );
  });

  it("defers live timeline updates only during direct user scrolling", () => {
    const hook = readSource("src/shell/use-chat-scroll-management.ts");
    const fullChat = readSource("src/app/chat/ChatColumn.tsx");
    const compactChat = readSource(
      "src/features/chat/CompactConversationSurface.tsx",
    );

    expect(hook).toContain("const noteManualScroll = useCallback");
    expect(hook).toMatch(
      /const handleWheel = \(event: WheelEvent\) => \{\s*noteManualScroll\(\)/,
    );
    expect(fullChat).toContain("useDeferredChatMessages(");
    expect(fullChat).toContain("isUserScrolling,");
    expect(compactChat).toContain("useDeferredChatMessages(");
    expect(compactChat).toContain("scroll.isUserScrolling,");
  });

  it("prewarms a wider virtualization runway outside the initial paint", () => {
    const timeline = readSource("src/app/chat/ChatTimeline.tsx");

    expect(timeline).toContain("CHAT_DRAW_DISTANCE_COLD_PX = 300");
    expect(timeline).toContain("CHAT_DRAW_DISTANCE_WARM_PX = 1_200");
    expect(timeline).toContain("window.requestIdleCallback");
    expect(timeline).toContain(
      "startTransition(() => setWarmedDataKey(dataKey))",
    );
    expect(timeline).toContain("drawDistance={drawDistance}");
  });

  it("uses Streamdown's static path for settled rows and keeps live rows streaming", () => {
    const markdown = readSource("src/app/chat/Markdown.tsx");
    const messageRow = readSource("src/app/chat/MessageRow.tsx");

    expect(markdown).toContain('mode = "static"');
    expect(markdown).toContain("mode={mode}");
    expect(messageRow).toContain(
      'mode={row.isStreaming ? "streaming" : "static"}',
    );
  });
});
