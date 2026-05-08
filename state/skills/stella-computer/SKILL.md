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
- `stella-computer press Return --app "<App>" --allow-hid` - press a key or key combination.
- `stella-computer scroll <id> down --app "<App>"` - scroll an element.
- `stella-computer fill <id> "text" --app "<App>"` - set or fill a settable Accessibility value.
- `stella-computer type "text" --app "<App>" --allow-hid` - type literal text through the keyboard.

## Interaction Rules

Use numbered element IDs when the visible UI is exposed in the accessibility tree. It is the most precise and resilient option.

Use screenshot pixel coordinates with `click-screenshot` when the element is visible in the screenshot but not addressable through the accessibility tree. `click-screenshot` is a no-raise background click by default; do not add `--allow-hid` or `--raise` unless a prior attempt explicitly says it needs a global fallback. After any point click, run `get-state` and confirm the app changed before assuming the click worked.

Use `drag-screenshot` and `drag-element` for drag operations only. These require `--allow-hid` because they can move the user's real cursor.

Avoid synthesized double-clicks with screenshot coordinates in web-view apps. Backgrounded webviews often drop them. Prefer a labeled action button, or single-click a row and press `Return` or `Space` with `--allow-hid`.

`press` and `type` require `--allow-hid` because keyboard events can affect the active input path. This does not mean you should use `--raise`: no-raise per-app delivery is tried first. Use `--raise` only as an explicit last resort when background delivery has failed and the user-visible focus change is acceptable.

Spotify and other Chromium/Electron media surfaces may reject pixel clicks on player controls even when Stella successfully posts the event. If a Spotify play/pause point click reports success but `get-state` does not change, prefer `stella-computer press Space --app "Spotify" --allow-hid` without `--raise`, then verify with `get-state`.

The target app is not intentionally raised or focused. Do not use `--raise` to make a click work; use it only after background-safe routes have failed and there is no other practical route.

For consumer services with both an app and a website, default to the desktop app. Try `stella-computer snapshot --app "<App>"` first, then fall back to `stella-browser` only if `stella-computer list-apps` confirms the app is unavailable.

Do not use `osascript`, `open -a`, AppleScript, `defaults write`, or shelling into app bundles to drive or inspect desktop apps.
