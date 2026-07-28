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
    const radialSearch = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/radial/RadialSearchOverlay.tsx"),
      "utf8",
    );

    expect(leadRow).not.toContain("ComposerSuggestionContextRow");
    expect(addMenu).toContain("<DropdownMenuLabel>Context</DropdownMenuLabel>");
    expect(activityPill).toContain("radialSearchStore.open()");
    expect(radialSearch).toContain(
      'placeholder="Search activity, files, and more"',
    );
  });

  it("keeps search out of Home and includes apps in radial results", () => {
    const home = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/HomeSection.tsx"),
      "utf8",
    );
    const radialSearch = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/radial/RadialSearchOverlay.tsx"),
      "utf8",
    );
    expect(home).not.toContain("sidebar-search__field");
    expect(radialSearch).toContain("includeUserApps");
  });
});
