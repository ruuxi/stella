---
name: computer-use
description: Desktop-app automation through Stella's local computer-use MCP pseudo-server.
---

# Computer Use

Use this skill when the user asks you to inspect or operate a desktop app, including Spotify, Discord, Slack, Messages, Notes, Mail, Calendar, Music, Telegram, WhatsApp, Signal, Linear, Notion, Obsidian, Figma, Zoom, Cursor, VS Code, App Store, Reminders, FaceTime, Photos, Maps, Finder, Safari, Chrome, or any other windowed app.

Most computer-use tools are deferred behind `MCP`; `computer_list_apps` is also available as a direct tool for quick app availability checks.

## Discover

Use direct `computer_list_apps` when you only need to see available apps. For app state and actions, list local and connected MCP servers:

```ts
MCP({ action: "servers" })
```

Inspect the computer-use tool catalog:

```ts
MCP({ action: "tools", server: "computer-use" })
```

## Call Pattern

Call computer-use action tools through MCP:

```ts
MCP({
  action: "call",
  server: "computer-use",
  tool: "computer_get_app_state",
  arguments: { app: "Spotify" }
})
```

Start every desktop-app turn with `computer_get_app_state` for the target app. It returns a numbered accessibility tree and an inline screenshot. Act on the returned element IDs with the interaction tools below.

## Tools

- `computer_list_apps` — list apps on this device. macOS returns running and recently used apps; Windows returns running top-level apps. Prefer the direct tool for this one.
- `computer_get_app_state` — start a session for an app if needed, then return its current accessibility tree and screenshot. Required: `app`.
- `computer_click` — click an element by `element_index`, or click screenshot coordinates with `x` and `y`. Required: `app`.
- `computer_drag` — drag from one screenshot pixel to another. Required: `app`, `from_x`, `from_y`, `to_x`, `to_y`.
- `computer_perform_secondary_action` — invoke a secondary Accessibility action such as `AXPress`, `AXRaise`, or `AXShowMenu`. Required: `app`, `element_index`, `action`.
- `computer_press_key` — press a key or key combination with the target app focused. Required: `app`, `key`.
- `computer_scroll` — scroll an element. Required: `app`, `element_index`, `direction`.
- `computer_set_value` — set a settable Accessibility element value. Required: `app`, `element_index`, `value`.
- `computer_type_text` — type literal text through the keyboard. Required: `app`, `text`.

## Interaction Rules

Use `element_index` when the visible UI is exposed in the accessibility tree. It is the most precise and resilient option.

Use screenshot `x`/`y` coordinates when the element is visible in the screenshot but not addressable through the accessibility tree. This is common in web-view-backed apps like Spotify, Slack, Discord, Notion, and Linear.

Avoid synthesized double-clicks with `click_count: 2` on screenshot coordinates in web-view apps. Backgrounded webviews often drop them. Prefer a labeled action button, or single-click a row and press `Return` or `Space`.

The target app is not intentionally raised or focused. To activate something visible, click it.

For consumer services with both an app and a website, default to the desktop app. Try `computer_get_app_state` first, then fall back to `stella-browser` only if `computer_list_apps` confirms the app is unavailable.

Do not use `exec_command`, `osascript`, `open -a`, AppleScript, `defaults write`, or shelling into app bundles to drive or inspect desktop apps.
