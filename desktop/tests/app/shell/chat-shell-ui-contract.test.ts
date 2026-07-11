// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getContextSuggestionLabel } from "@/app/chat/ComposerAddMenu";
import { getDisplayedActivityPillState } from "@/app/chat/ComposerActivityPill";
import { isComposerContextMenuTarget } from "@/shell/context-menu/StellaContextMenu";
import type { ComposerContextSuggestion } from "@/app/chat/ComposerContextRow";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

describe("chat shell UI contracts", () => {
  it("keeps the activity pill visible but suppresses running state while the sidebar is docked", () => {
    expect(getDisplayedActivityPillState("running", false)).toBe("running");
    expect(getDisplayedActivityPillState("running", true)).toBe("idle");
    expect(getDisplayedActivityPillState("done", true)).toBe("done");
  });

  it("labels app and browser context options for the + menu", () => {
    const app: ComposerContextSuggestion = {
      key: "app:42",
      phase: "stable",
      chip: {
        kind: "app",
        pid: 42,
        name: "System Settings",
        windowTitle: "Privacy & Security",
        isActive: true,
      },
    };
    const tab: ComposerContextSuggestion = {
      key: "tab:safari",
      phase: "stable",
      chip: {
        kind: "tab",
        browser: "Safari",
        bundleId: "com.apple.Safari",
        url: "https://chatgpt.com/",
        host: "chatgpt.com",
        title: "ChatGPT",
      },
    };

    expect(getContextSuggestionLabel(app)).toBe(
      "System Settings — Privacy & Security",
    );
    expect(getContextSuggestionLabel(tab)).toBe("Safari — ChatGPT");
  });

  it("allows native context menus inside composer forms only", () => {
    const form = document.createElement("form");
    form.dataset.composerContextMenu = "native";
    const textarea = document.createElement("textarea");
    form.appendChild(textarea);
    const outside = document.createElement("div");

    expect(isComposerContextMenuTarget(textarea)).toBe(true);
    expect(isComposerContextMenuTarget(form)).toBe(true);
    expect(isComposerContextMenuTarget(outside)).toBe(false);
  });

  it("moves suggestion UI into + and keeps search above the composer", () => {
    const leadRow = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/ComposerLeadRow.tsx"),
      "utf8",
    );
    const addMenu = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/ComposerAddMenu.tsx"),
      "utf8",
    );
    const sidebar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/LeftSidebar.tsx"),
      "utf8",
    );
    const activityPill = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/ComposerActivityPill.tsx"),
      "utf8",
    );

    expect(leadRow).not.toContain("ComposerSuggestionContextRow");
    expect(addMenu).toContain("<DropdownMenuLabel>Context</DropdownMenuLabel>");
    expect(sidebar).not.toContain("left-sidebar__search-row");
    expect(activityPill).toContain(
      'placeholder="Search activity, files, and more"',
    );
  });

  it("keeps tray search out of the left sidebar activity index", () => {
    const sidebar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/LeftSidebar.tsx"),
      "utf8",
    );

    // The sidebar must not subscribe to the tray's shared search store, or
    // typing in the activity-tray popover would leak filtered results into
    // the sidebar's stable activity index.
    expect(sidebar).not.toContain("useDisplaySearchQuery");
    expect(sidebar).not.toContain("display-search-store");
    // It renders the overview unfiltered (no query prop threaded in).
    expect(sidebar).toContain('<LeftSidebarSections variant="overview" />');
  });

  it("reserves a stable tray height while searching so it doesn't snap per keystroke", () => {
    const activityPill = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/ComposerActivityPill.tsx"),
      "utf8",
    );
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/composer-activity-pill.css"),
      "utf8",
    );

    // The tray marks itself as searching off the immediate input (not the
    // deferred query) so the reserve engages before results reconcile.
    expect(activityPill).toContain("const searching = inputValue.trim().length > 0");
    expect(activityPill).toContain("data-searching={searching || undefined}");
    // CSS holds the results region at a reserved height while searching.
    expect(css).toMatch(
      /\.composer-activity-tray\[data-searching\][\s\S]*?min-height:/,
    );
  });
});
