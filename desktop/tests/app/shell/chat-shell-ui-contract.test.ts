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
import { isComposerContextMenuTarget } from "@/shell/context-menu/StellaContextMenu";
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

    expect(isComposerContextMenuTarget(textarea)).toBe(true);
    expect(isComposerContextMenuTarget(form)).toBe(true);
    expect(isComposerContextMenuTarget(outside)).toBe(false);
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
    expect(leadRow).not.toContain("ComposerSuggestionContextRow");
    expect(addMenu).toContain("<DropdownMenuLabel>Context</DropdownMenuLabel>");
    expect(activityPill).toContain(
      'sidebarSections.openLocation("home", null)',
    );
  });

  it("keeps workspace search in Home", () => {
    const home = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/HomeSection.tsx"),
      "utf8",
    );
    expect(home).toContain("sidebar-search__field");
    expect(home).toContain('placeholder="Search activity, files, and more"');
  });

  it("keeps the closed display header from swallowing top-bar clicks", () => {
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/shell-topbar-full.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.display-panel-topbar\[data-display-open="false"\]\s+\*\s*\{[^}]*-webkit-app-region:\s*no-drag/,
    );
  });

  it("keeps Home out of the full top bar and opens Settings in the sidebar", () => {
    const fullTopBar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/ShellTopBarFull.tsx"),
      "utf8",
    );
    const panelTopBar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/DisplayPanelTopBar.tsx"),
      "utf8",
    );
    const sidebarTabRail = fs.readFileSync(
      path.join(
        SOURCE_ROOT,
        "shell/sidebar-sections/SidebarTabRail.tsx",
      ),
      "utf8",
    );
    const account = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar/ShellTopBarAccount.tsx"),
      "utf8",
    );
    const settingsSection = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/SettingsSection.tsx"),
      "utf8",
    );

    expect(fullTopBar).toContain('["apps", "chat"]');
    expect(sidebarTabRail).toContain(
      '["home", "files", "apps"] as const',
    );
    expect(panelTopBar).toContain(
      'sidebarSections.openLocation("settings", null)',
    );
    expect(account).toContain(
      'sidebarSections.openLocation("settings", null)',
    );
    expect(settingsSection).toContain("<SettingsScreen embedded");
    expect(settingsSection).toContain("<ThemePicker inline");
    expect(settingsSection).toContain("<ConnectPanel");
    expect(settingsSection).toContain("<FeedbackPanel");
    expect(account).not.toContain("<DropdownMenu");
    expect(account).not.toContain("<ThemePicker");
    expect(account).not.toContain("<FeedbackDialog");
  });

  it("anchors Models at the bottom right of the sidebar Home section", () => {
    const home = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/HomeSection.tsx"),
      "utf8",
    );
    const account = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar/ShellTopBarAccount.tsx"),
      "utf8",
    );
    const defaultTabs = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/display/default-tabs.tsx"),
      "utf8",
    );

    expect(home).toContain("sidebar-home-footer");
    expect(home).toContain("<ModelsPicker");
    expect(home).toContain("sidebar-home-models-button");
    expect(account).not.toContain("<ModelsPicker");
    expect(defaultTabs).toContain(
      'sidebarSections.openLocation("home", null)',
    );
  });
});
