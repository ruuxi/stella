---
name: stella-computer
description: Windows desktop-app automation through Stella's stella-computer CLI.
---

# Stella Computer for Windows

Use this skill when the user asks you to inspect or operate a Windows desktop app, including Spotify, Discord, Slack, Teams, Notion, Obsidian, Figma, Zoom, Cursor, VS Code, Photos, Settings, File Explorer, Chrome, Edge, or any other windowed app.

Use `stella-computer` through `exec_command`.

## Discover

List visible apps:

```bash
stella-computer list-apps
```

List individual top-level windows when an app has more than one window:

```bash
stella-computer list-windows
```

Snapshot a target app or exact window:

```bash
stella-computer snapshot --app "Spotify"
stella-computer snapshot --window-id 123456
```

Start every desktop-app turn with `snapshot` for the target app or window. It returns a numbered UI Automation tree and an inline screenshot. Act on the returned element IDs with the interaction commands below.

## Commands

- `stella-computer list-apps` - list visible apps on this device.
- `stella-computer list-windows` - list visible top-level windows with `pid`, `window-id`, title, and bounds.
- `stella-computer snapshot --app "<App>"` - return the current UI Automation tree and screenshot.
- `stella-computer snapshot --window-id <hwnd>` - snapshot one exact top-level window.
- `stella-computer click <id> --app "<App>"` - click a UI Automation element from the latest snapshot.
- `stella-computer click-screenshot <x> <y> --window-id <hwnd>` - click screenshot coordinates.
- `stella-computer drag-screenshot <from_x> <from_y> <to_x> <to_y> --app "<App>"` - drag between screenshot coordinates.
- `stella-computer secondary-action <id> Invoke --app "<App>"` - invoke a UI Automation pattern.
- `stella-computer scroll <id> down --app "<App>"` - scroll an element.
- `stella-computer fill <id> "text" --app "<App>"` - set a UI Automation value.
- `stella-computer type "text" --app "<App>"` - type literal text.
- `stella-computer press Return --app "<App>"` - press a key or key combination.

## Interaction Rules

Use numbered element IDs when the UI is exposed in the tree. It is the most precise option and usually works in the background through UI Automation.

Use `list-windows` plus `--window-id` when there are multiple windows with the same app name, when the title matters, or when the model needs to keep one window stable across actions.

Use screenshot coordinates only when the visible control is not addressable in the tree. After any point click, run `get-state` and confirm the app changed before assuming the click worked.

Windows background input is not uniform across frameworks. If an action reports `background_unavailable`, retry the same command with `--dispatch foreground` only when a brief focus/cursor movement is acceptable. Prefer `--dispatch auto` when the task is more important than preserving strict background behavior.

For Chromium/Electron, UWP/XAML, GTK, VCL, and elevated apps, prefer UI Automation element actions first. Pixel clicks and keyboard messages may be refused by Windows or silently ignored by the target framework.

Do not use PowerShell, registry edits, app bundle paths, or app-specific scripting to drive desktop apps unless the user explicitly asked for those surfaces.
