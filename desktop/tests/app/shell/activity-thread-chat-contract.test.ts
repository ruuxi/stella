import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Activity exact-thread chat UI contract", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "src/shell/LeftSidebarSections.tsx"),
    "utf8",
  );
  const css = readFileSync(
    path.resolve(process.cwd(), "src/app/chat/chat-workspace-strip.css"),
    "utf8",
  );

  it("opens read-only agent chat without mutating composer context", () => {
    const handler = source.slice(
      source.indexOf("const handleSelectTask"),
      source.indexOf("if (!hasActivity"),
    );
    expect(handler).toContain("openAgentThreadTab");
    expect(handler).toContain("threadId: task.id");
    expect(handler).not.toContain("setChatContext");
    expect(handler).not.toContain("requestFocus");
    expect(source).toContain("Open read-only chat for");
  });

  it("reserves no trailing width until hover/focus and remains touch-visible", () => {
    expect(css).toMatch(
      /\.chat-workspace-strip__task-attach\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*2px;[\s\S]*?width:\s*26px;/,
    );
    expect(css).toMatch(
      /task-row-head:focus-within[\s\S]*?padding-right:\s*32px;/,
    );
    expect(css).not.toMatch(/margin-right:\s*-/);
    expect(css).toMatch(/@media \(hover: none\), \(pointer: coarse\)/);
  });
});
