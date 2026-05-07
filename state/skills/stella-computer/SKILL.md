---
name: stella-computer
description: Desktop-app automation through Stella's stella-computer CLI.
---

# Stella Computer

Use this skill when the user asks you to inspect or operate a desktop app, including Spotify, Discord, Slack, Messages, Notes, Mail, Calendar, Music, Telegram, WhatsApp, Signal, Linear, Notion, Obsidian, Figma, Zoom, Cursor, VS Code, App Store, Reminders, FaceTime, Photos, Maps, Finder, Safari, Chrome, or any other windowed app.

Use `stella-computer` through `exec_command`.

## Discover

List available apps:

```bash
stella-computer list-apps
```

Snapshot a target app:

```bash
stella-computer snapshot --app "Spotify"
```

Start every desktop-app turn with `snapshot` for the target app. It returns a numbered accessibility tree and an inline screenshot. Act on the returned element IDs with the interaction commands below.

## Commands

- `stella-computer list-apps` - list apps on this device.
- `stella-computer snapshot --app "<App>"` - return the current accessibility tree and screenshot.
- `stella-computer click <id> --app "<App>"` - click an accessibility element from the latest snapshot.
- `stella-computer click-screenshot <x> <y> --app "<App>"` - click screenshot coordinates.
- `stella-computer drag <from_x> <from_y> <to_x> <to_y> --app "<App>"` - drag between screen coordinates.
- `stella-computer drag-screenshot <from_x> <from_y> <to_x> <to_y> --app "<App>"` - drag between screenshot coordinates.
- `stella-computer drag-element <source-id> <dest-id> --app "<App>"` - drag an element to another element when the app exposes usable AX refs.
- `stella-computer secondary-action <id> AXPress --app "<App>"` - invoke an Accessibility action.
- `stella-computer press Return --app "<App>"` - press a key or key combination.
- `stella-computer scroll <id> down --app "<App>"` - scroll an element.
- `stella-computer fill <id> "text" --app "<App>"` - set or fill a settable Accessibility value.
- `stella-computer type "text" --app "<App>"` - type literal text through the keyboard.

## Interaction Rules

Use numbered element IDs when the visible UI is exposed in the accessibility tree. It is the most precise and resilient option.

Use screenshot pixel coordinates with `click-screenshot` or `drag-screenshot` when the element is visible in the screenshot but not addressable through the accessibility tree. Use `drag-element` for source/destination AX refs when the app exposes a real draggable item. This is common in web-view-backed apps like Spotify, Slack, Discord, Notion, and Linear.

Avoid synthesized double-clicks with screenshot coordinates in web-view apps. Backgrounded webviews often drop them. Prefer a labeled action button, or single-click a row and press `Return` or `Space`.

The target app is not intentionally raised or focused. To activate something visible, click it.

For consumer services with both an app and a website, default to the desktop app. Try `stella-computer snapshot --app "<App>"` first, then fall back to `stella-browser` only if `stella-computer list-apps` confirms the app is unavailable.

Do not use `osascript`, `open -a`, AppleScript, `defaults write`, or shelling into app bundles to drive or inspect desktop apps.
