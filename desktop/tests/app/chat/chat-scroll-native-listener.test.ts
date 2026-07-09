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
});
