import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Activity exact-thread chat UI contract", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "src/shell/workspace/WorkspaceSections.tsx"),
    "utf8",
  );
  const css = readFileSync(
    path.resolve(process.cwd(), "src/app/chat/chat-workspace-strip.css"),
    "utf8",
  );

  it("opens exact-thread activity without mutating composer context", () => {
    const handler = source.slice(
      source.indexOf("const handleSelectTask"),
      source.indexOf("if (!hasActivity"),
    );
    expect(handler).toContain("openAgentThreadTab");
    expect(handler).toContain("threadId: task.id");
    expect(handler).not.toContain("setChatContext");
    expect(handler).not.toContain("requestFocus");
    expect(source).toContain('"View activity"');
    expect(source).toContain("<Eye");
    expect(source).not.toContain("Open read-only chat for");
    expect(handler).toContain("source: task.source");
    expect(handler).toContain("readOnly: task.readOnly");
    expect(source).toContain('"Claude · read-only"');
    expect(source).toContain('"View Claude conversation"');
  });

  it("keeps the narrow last-row action and hover background inside the scroll boundary", () => {
    expect(css).toMatch(
      /\.chat-workspace-strip__panel\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?overflow-x:\s*hidden;/,
    );
    expect(css).toMatch(
      /\.chat-workspace-strip__list--tasks\s*>\s*\.chat-workspace-strip__task-row\s*\{[\s\S]*?overflow:\s*visible clip;/,
    );
    expect(css).not.toMatch(
      /\.chat-workspace-strip__panel\s*\{[\s\S]*?overflow:\s*visible;/,
    );
    expect(css).toMatch(
      /\.chat-workspace-strip__task-attach\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*2px;[\s\S]*?width:\s*26px;/,
    );
    expect(css).toMatch(
      /\.chat-workspace-strip__task-button\s*\{[\s\S]*?min-width:\s*0;/,
    );
    expect(css).toMatch(
      /task-row-head\s+\.chat-workspace-strip__task-button\s*\{[\s\S]*?margin-right:\s*0;/,
    );
    expect(css).toMatch(
      /task-row-head:focus-within[\s\S]*?padding-right:\s*32px;/,
    );
    // At a deliberately narrow 160px row, the 26px hit target remains fully
    // inset: [132, 158], never crossing the right clip edge at 160.
    const narrowRowWidth = 160;
    const actionWidth = 26;
    const actionRightInset = 2;
    const actionLeft = narrowRowWidth - actionRightInset - actionWidth;
    expect(actionLeft).toBeGreaterThanOrEqual(0);
    expect(actionLeft + actionWidth).toBeLessThan(narrowRowWidth);
    expect(css).not.toMatch(/margin-right:\s*-/);
    expect(css).toMatch(/@media \(hover: none\), \(pointer: coarse\)/);
  });
});
