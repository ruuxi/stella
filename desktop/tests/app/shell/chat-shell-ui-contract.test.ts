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
import { displaySearchStore } from "@/features/workspace-display/display-search-store";
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

  it("keeps the right sidebar inside the app-wide right-click handler", () => {
    const root = fs.readFileSync(
      path.join(SOURCE_ROOT, "routes/__root.tsx"),
      "utf8",
    );
    const contextMenuStart = root.indexOf("<StellaContextMenu");
    const rightSidebar = root.indexOf("<RightSidebar", contextMenuStart);
    const contextMenuEnd = root.indexOf(
      "</StellaContextMenu>",
      contextMenuStart,
    );

    expect(contextMenuStart).toBeGreaterThanOrEqual(0);
    expect(rightSidebar).toBeGreaterThan(contextMenuStart);
    expect(contextMenuEnd).toBeGreaterThan(rightSidebar);
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
    expect(activityPill).toContain("displaySearchStore.open()");
  });

  it("keeps the optimized search in Home but reveals it only on request", () => {
    const home = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/HomeSection.tsx"),
      "utf8",
    );
    expect(home).toContain("sidebar-search__field");
    expect(home).toContain('searchMode="quick"');
    expect(home).toContain("searchOpen ?");
    expect(home).toContain("inputRef.current?.focus()");
    expect(home).toContain("}, 150)");
    expect(home).toContain("useDeferredValue(query)");
    expect(home).toContain("const renderEmpty = useCallback(");
    expect(home).toContain("renderEmpty={renderEmpty}");
    expect(home).toContain('placeholder="Search activity, files, and more"');
  });

  it("uses emphasis instead of a selected-tab tint", () => {
    const css = fs.readFileSync(
      path.join(
        SOURCE_ROOT,
        "shell/sidebar-sections/sidebar-tab-rail.css",
      ),
      "utf8",
    );
    expect(css).toMatch(
      /\.sidebar-tab-rail__tab\[data-active="true"\]\s*\{[^}]*background:\s*transparent;[^}]*font-weight:\s*var\(--weight-semibold\)/,
    );
    expect(css).toMatch(
      /\.sidebar-tab-rail__tab\[data-active="true"\]\s+\.sidebar-tab-rail__icon svg\s*\{[^}]*stroke-width:\s*2\.25/,
    );
  });

  it("replaces closed account controls with the animated sidebar header", () => {
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/shell-topbar-full.css"),
      "utf8",
    );
    const panelTopBar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/DisplayPanelTopBar.tsx"),
      "utf8",
    );
    const fullTopBar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/ShellTopBarFull.tsx"),
      "utf8",
    );
    expect(css).toMatch(
      /\.display-panel-topbar\[data-display-open="false"\]\s*\{[^}]*clip-path:\s*inset\(0 0 0 100%\)/,
    );
    expect(css).toMatch(
      /\.display-panel-topbar\s*\{[^}]*clip-path 460ms/,
    );
    expect(panelTopBar).toContain("aria-hidden={!panelOpen}");
    expect(panelTopBar).toContain("inert={!panelOpen}");
    expect(panelTopBar).toContain("displayTabs.setPanelOpen(!panelOpen)");
    expect(panelTopBar).toContain("<PanelRight");
    expect(panelTopBar).toContain("aria-expanded={panelOpen}");
    expect(panelTopBar).not.toContain(
      'data-active={panelOpen ? "true" : undefined}',
    );
    expect(panelTopBar).not.toContain("aria-pressed={panelOpen}");
    expect(panelTopBar).not.toContain("<DisplayPanelControls");
    expect(fullTopBar).toContain("<ShellTopBarAccount onSignIn={onSignIn}");
    expect(fullTopBar).toContain("!panelOpen ?");
    expect(fullTopBar).toContain("displayTabs.setPanelOpen(true)");
    expect(fullTopBar).toContain("<Settings size={14}");
  });

  it("keeps the right sidebar and its top bar borderless on the left", () => {
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/shell-junction.css"),
      "utf8",
    );
    const rightSidebarCss = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/right-sidebar.css"),
      "utf8",
    );
    expect(css).not.toMatch(
      /\.right-sidebar\.right-sidebar-panel\.right-sidebar--shell-visible\s*\{[^}]*border-left:/,
    );
    expect(css).not.toMatch(
      /\.display-panel-topbar\[data-display-open="true"\][^{]*\{[^}]*border-left:/,
    );
    expect(rightSidebarCss).toMatch(
      /\.right-sidebar__resize-handle::before\s*\{[^}]*width:\s*2px;[^}]*background:\s*var\(--border-strong\)/,
    );
    expect(rightSidebarCss).toMatch(
      /\.right-sidebar__resize-handle\s*\{[^}]*width:\s*12px/,
    );
  });

  it("shows no selected sidebar destination while the panel is closed", () => {
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
    expect(sidebarTabRail).toContain(
      "const active = panelOpen && section === activeSection",
    );
    expect(panelTopBar).toContain(
      'panelOpen && activeSection === "settings"',
    );
  });

  it("keeps the account right-aligned inside the panel-animated main column", () => {
    const root = fs.readFileSync(
      path.join(SOURCE_ROOT, "routes/__root.tsx"),
      "utf8",
    );
    const fullTopBar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/ShellTopBarFull.tsx"),
      "utf8",
    );
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/shell-topbar-full.css"),
      "utf8",
    );
    expect(root).toContain("<ShellTopBarFull onSignIn={showAuthDialog}");
    expect(root).toContain("<DisplayPanelTopBar />");
    expect(fullTopBar).toContain("<ShellTopBarAccount onSignIn={onSignIn}");
    expect(fullTopBar).toContain("useDisplayPanelOpen");
    expect(css).toMatch(
      /\.shell-topbar-full__right\s*\{[^}]*display:\s*flex;[^}]*margin-left:\s*auto/,
    );
    expect(css).not.toContain(".shell-topbar-persistent-right");
    expect(css).not.toContain(".shell-topbar-full__account-slot");
  });

  it("keeps the persistent sidebar controls close to their left edge", () => {
    const topbarCss = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/shell-topbar-full.css"),
      "utf8",
    );
    const railCss = fs.readFileSync(
      path.join(
        SOURCE_ROOT,
        "shell/sidebar-sections/sidebar-tab-rail.css",
      ),
      "utf8",
    );
    expect(topbarCss).toMatch(
      /\.shell-topbar-full__right \.shell-topbar-account-(?:signin|trigger)[^{]*\{[^}]*padding-right:\s*6px/,
    );
    expect(topbarCss).toMatch(
      /\.display-panel-topbar\s*\{[^}]*padding:\s*0 10px 0 6px/,
    );
    expect(railCss).toMatch(
      /\.sidebar-tab-rail__tab\s*\{[^}]*padding:\s*0 7px/,
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
    expect(panelTopBar).toContain('className="shell-topbar-account-settings"');
    expect(panelTopBar).toContain("<Settings size={14}");
    expect(settingsSection).toContain("<SettingsScreen embedded");
    expect(settingsSection).toContain("<ThemePicker inline");
    expect(settingsSection).toContain("<ConnectPanel");
    expect(settingsSection).toContain("<BillingPanel");
    expect(settingsSection).toContain("<FeedbackPanel");
    expect(settingsSection).toContain('label: "Plan & billing"');
    expect(settingsSection).toContain("signedInOnly: true");
    expect(account).toContain("<DropdownMenu");
    expect(account).toContain('data-variant="destructive"');
    expect(account).toContain("sidebar-signout-dialog");
    expect(account).not.toContain("SettingsIcon");
    expect(account).not.toContain("useDisplayPanelOpen");
    expect(account).not.toContain("<ThemePicker");
    expect(account).not.toContain("<FeedbackDialog");
  });

  it("reissues focus requests and clears the shared query when search closes", () => {
    displaySearchStore.close();
    const before = displaySearchStore.getSnapshot().focusRequest;

    displaySearchStore.open();
    expect(displaySearchStore.getSnapshot()).toMatchObject({
      open: true,
      focusRequest: before + 1,
    });

    displaySearchStore.setQuery("files");
    displaySearchStore.open();
    expect(displaySearchStore.getSnapshot()).toMatchObject({
      query: "files",
      open: true,
      focusRequest: before + 2,
    });

    displaySearchStore.close();
    expect(displaySearchStore.getSnapshot()).toMatchObject({
      query: "",
      open: false,
    });
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
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/sidebar-sections/home-search.css"),
      "utf8",
    );

    expect(home).toContain("sidebar-home-footer");
    expect(home).toContain("<ModelsPicker");
    expect(home).toContain("sidebar-home-models-button");
    expect(css).toMatch(
      /\.pill-btn\.sidebar-home-models-button\s*\{[^}]*border:\s*none/,
    );
    expect(account).not.toContain("<ModelsPicker");
    expect(defaultTabs).toContain(
      'sidebarSections.openLocation("home", null)',
    );
  });
});
