// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getContextSuggestionLabel } from "@/app/chat/ComposerAddMenu";
import {
  getActivityPillLabel,
  getDisplayedActivityPillState,
} from "@/app/chat/ComposerActivityPill";
import { isRadialGestureExempt } from "@/shell/radial/radial-gesture-target";
import { shouldHoldSearchLayout } from "@/shell/sidebar-sections/SearchSection";
import type { ComposerContextSuggestion } from "@/app/chat/ComposerContextRow";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

describe("chat shell UI contracts", () => {
  it("keeps the activity pill visible but suppresses running state while Tasks is on screen", () => {
    expect(getDisplayedActivityPillState("running", false)).toBe("running");
    expect(getDisplayedActivityPillState("running", true)).toBe("idle");
    expect(getDisplayedActivityPillState("done", true)).toBe("done");
    expect(getActivityPillLabel("running", 1)).toBe("1 task in progress");
    expect(getActivityPillLabel("running", 2)).toBe("2 tasks in progress");
  });

  it("keeps compact grid cells stationary and their pulse locally scoped", () => {
    const sections = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/workspace/WorkspaceSections.tsx"),
      "utf8",
    );
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/chat-workspace-strip.css"),
      "utf8",
    );

    // `anim-pulse` belongs to ConnectHeroAnimation and scales around its SVG
    // coordinate transform-origin. Reusing it on a 4px cell caused the dot to
    // travel diagonally; Activity must use only its namespaced animation.
    expect(sections).not.toMatch(
      /compact-(?:cell|bar-segment)[^\n]*anim-pulse/,
    );
    expect(sections).toContain("key={task.id}");

    const cellIn = css.match(
      /@keyframes chat-workspace-strip__compact-cell-in\s*\{([\s\S]*?)\n\}/,
    );
    expect(cellIn?.[1]).toContain("opacity: 0");
    expect(cellIn?.[1]).not.toContain("transform");
    expect(css).toContain(
      ".chat-workspace-strip__compact-cell--running::before",
    );
    expect(css).toMatch(
      /\.chat-workspace-strip__compact-cell\s*\{[\s\S]*?animation: chat-workspace-strip__compact-cell-in/,
    );
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

  it("leaves the right button to native menus inside composer forms only", () => {
    const form = document.createElement("form");
    form.dataset.composerContextMenu = "native";
    const textarea = document.createElement("textarea");
    form.appendChild(textarea);
    const outside = document.createElement("div");

    expect(isRadialGestureExempt(textarea)).toBe(true);
    expect(isRadialGestureExempt(form)).toBe(true);
    expect(isRadialGestureExempt(outside)).toBe(false);
  });

  it("moves suggestion UI into + and keeps search one click from the composer", () => {
    const leadRow = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/ComposerLeadRow.tsx"),
      "utf8",
    );
    const addMenu = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/ComposerAddMenu.tsx"),
      "utf8",
    );
    const activityPill = fs.readFileSync(
      path.join(SOURCE_ROOT, "app/chat/ComposerActivityPill.tsx"),
      "utf8",
    );
    const search = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/SearchSection.tsx"),
      "utf8",
    );

    expect(leadRow).not.toContain("ComposerSuggestionContextRow");
    expect(addMenu).toContain("<DropdownMenuLabel>Context</DropdownMenuLabel>");
    // The pill is the entry point; the field itself lives in the Search
    // section. `openLocation` rather than `selectSection`, so a second click
    // can never close the panel on a live query.
    expect(activityPill).toContain(
      'sidebarSections.openLocation("search", null)',
    );
    expect(search).toContain('placeholder="Search activity, files, and more"');
  });

  it("keeps Search's query out of the Tasks activity index", () => {
    const tasks = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/TasksSection.tsx"),
      "utf8",
    );
    const search = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/SearchSection.tsx"),
      "utf8",
    );

    // Tasks must not subscribe to the shared search store, or typing in the
    // Search tab would leak filtered results into the stable activity index.
    expect(tasks).not.toContain("useDisplaySearchQuery");
    expect(tasks).not.toContain("display-search-store");
    // It renders the overview unfiltered (no query prop threaded in).
    expect(tasks).toMatch(/<WorkspaceSections\s+variant="overview"/);
    expect(tasks).not.toMatch(/\bquery=/);

    // Search is the one surface that does thread the query through.
    expect(search).toContain("useDisplaySearchQuery");
    expect(search).toContain("query={deferredQuery}");
  });

  it("holds the search layout through engage and a single-settle clear", () => {
    // Engages on the very first keystroke, before the deferred results
    // reconcile (immediate input drives it on).
    expect(shouldHoldSearchLayout("a", "")).toBe(true);
    // Steady state while searching: both the input and the rendered query set.
    expect(shouldHoldSearchLayout("map", "map")).toBe(true);
    // Two-stage-drop regression: after the field is cleared the results still
    // render the previous query for ~150ms. The layout MUST stay held so the
    // box collapses once (when results reconcile), not twice. A naive
    // input-only predicate returns false here and fails this assertion.
    expect(shouldHoldSearchLayout("", "map")).toBe(true);
    // Only once both the field and the deferred results have cleared does the
    // section release its fixed layout back to the natural overview height.
    expect(shouldHoldSearchLayout("", "")).toBe(false);
    // Whitespace-only input is not a search.
    expect(shouldHoldSearchLayout("   ", "")).toBe(false);
  });

  it("bounds the searching results box to a resolved height with internal scroll", () => {
    const search = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/SearchSection.tsx"),
      "utf8",
    );
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/search-section.css"),
      "utf8",
    );

    // The component drives the searching layout off the hold predicate (not a
    // bare input check) and marks the section for CSS.
    expect(search).toContain(
      "shouldHoldSearchLayout(inputValue, deferredQuery)",
    );
    expect(search).toContain("data-searching={searching || undefined}");

    // The base body scrolls its overflow internally.
    expect(css).toMatch(/\.sidebar-search__body\s*\{[^}]*overflow-y:\s*auto/);

    // While searching the body is pinned to a RESOLVED height (a zero
    // flex-basis filling what the field leaves) so it can't grow/shrink with
    // the match count. A `min-height` floor leaves the region content-driven
    // above the floor and does NOT satisfy this.
    const searchingBody = css.match(
      /\.sidebar-search\[data-searching\]\s+\.sidebar-search__body\s*\{([^}]*)\}/,
    );
    expect(searchingBody).not.toBeNull();
    const decls = searchingBody?.[1] ?? "";
    expect(decls).toMatch(/(^|[;{\s])flex:\s*1\s+1\s+0\s*;/);
    expect(decls).not.toMatch(/min-height:/);
  });
});
