---
name: stella-computer
description: Drive macOS apps in the background through Accessibility, with compact numbered snapshots and auto-attached screenshots. Always targets a specific app and never disturbs the user's focus.
---

# stella-computer

`stella-computer` controls macOS apps for the user without taking over their screen. Every action dispatches via the Accessibility API to a **specific app** that you name explicitly. The user's active window, focus, clipboard, and physical cursor stay theirs. They can keep using their computer while you work.

For browser DOM use `stella-browser`. For everything else on the desktop — Finder, Notes, Calendar, Mail, Messages, Safari, Spotify, third-party apps — use `stella-computer`.

## Hard rules (read these before doing anything else)

1. **Always pass a target on every command.** `--app <Name>`, `--bundle-id <id>`, or `--pid <pid>`. There is no frontmost-app fallback. `stella-computer snapshot` with no target will return an error telling you to name one.
2. **Never raise the target.** Don't use `--raise`. Don't `open -a`, `osascript activate`, Spotlight, or any other "bring to front" trick. The tool drives the app via Accessibility — the app does not need to be focused, visible, or on top. Raising would steal the user's attention.
3. **Snapshot first, every turn.** Before you act on an app in a new turn, run `stella-computer snapshot --app <Name>` to refresh the numbered element tree and screenshot. Element IDs are tied to the snapshot.
4. **Prefer element IDs over pixel coordinates.** `click 12`, `secondary-action 165 AXPress`, `fill 9 "..."` — these are AX dispatches and work in the background. Pixel-coordinate commands (`click-point`, `click-screenshot`, `drag*`, `type`, `press`) require the app to actually be visible at that point or focused, so they're escape hatches, not the main path.
5. **Never fall back to AppleScript / `osascript` / shell `open -a` to drive an app.** If `stella-computer` can't reach the target, stop and report what failed. Do not mix in another control method.
6. **Ask before destructive or externally visible actions** — sending messages, deleting files, purchases, posting publicly, signing forms.

## Code mode usage

From inside an `Exec` program, drive `stella-computer` through `tools.shell`. The CLI is on `PATH` and the agent's session id is wired automatically.

```ts
const apps = await tools.shell({ command: "stella-computer list-apps" });
const snap = await tools.shell({
  command: "stella-computer snapshot --app Spotify",
});
text(snap.output);
```

## Core workflow

1. **Discover** the target app (only when you don't already know it): `stella-computer list-apps`
2. **Snapshot** the named app: `stella-computer snapshot --app <Name>` → returns a numbered element tree, an inline screenshot, and `<app_specific_instructions>` for that app if Stella has any.
3. **Act** by element ID: `click <id>`, `fill <id> <text>`, `focus <id>`, `secondary-action <id> <action>`, `scroll <id> <dir>`.
4. Each successful action **auto-refreshes** the snapshot and re-attaches a fresh screenshot.

```bash
stella-computer list-apps
stella-computer snapshot --app Spotify
stella-computer secondary-action 165 AXPress       # Playback > Play (background)
```

The snapshot screenshot auto-attaches as a vision content block on your next turn. Don't `tools.read_file` for the screenshot path — it's already in your context.

## Reading a snapshot

```
<app_specific_instructions>
## Spotify Computer Use
...
</app_specific_instructions>
<app_state>
App=com.spotify.client (pid 464)
Window: "Spotify Premium", App: Spotify.
0 standard window Spotify Premium, Secondary Actions: AXRaise
14 menu bar
	15 menu bar item Apple
	16 menu bar item Spotify
	20 menu bar item Playback
		164 menu
			165 menu item Play
			167 menu item Next
			168 menu item Previous
The focused UI element is 0 standard window.
</app_state>
[stella-attach-image] 2192x1688 ... /path/to/last-snapshot.png
```

- One node per line, tab-indented.
- `<id> <role> [(<state-flags>)] <label>[, Secondary Actions: a, b, c][, ID: ...][, URL: ...]`
- Roles are stripped of `AX` and lowercased.
- State flags only show when set: `disabled`, `selected`, `focused`, plus `settable` / value type when relevant.
- `AXPress` (regular click) is implicit on every clickable node and not listed under Secondary Actions; everything else is.
- The menu bar (`<id> menu bar` and its `menu bar item` children) is included in every snapshot. For Electron-style apps with shallow window trees (Spotify, Discord, Slack, VS Code, Notion, web wrappers), driving the app's menu bar via `secondary-action <menu-item-id> AXPress` is the canonical path — it dispatches via AX without focus.

If you see an `<app_specific_instructions>` block, read it before acting. Stella ships per-app guidance for Finder, Notes, Calendar, Messages, Safari, Spotify, and others; it covers app-specific gotchas.

## Commands

```bash
# Discovery
stella-computer list-apps

# Snapshot (target is REQUIRED)
stella-computer snapshot --app Spotify
stella-computer snapshot --bundle-id com.apple.Notes
stella-computer snapshot --pid 504
stella-computer snapshot --app Finder --all-windows
stella-computer snapshot --app Finder --max-depth 6 --max-nodes 800
stella-computer get-state --app Spotify             # alias for snapshot

# Element-targeted actions (Accessibility — work in background)
stella-computer click 4
stella-computer fill 9 "search text"
stella-computer focus 12
stella-computer secondary-action 8 AXShowMenu
stella-computer secondary-action 8 AXRaise          # raise a SPECIFIC window of the target
stella-computer scroll 23 down
stella-computer scroll 23 down --pages 3

# Content drag-and-drop (uses source element's pasteboard payload)
stella-computer drag-element 7 12 --allow-hid
stella-computer drag-element 7 --to-x 600 --to-y 400 --type file --allow-hid

# Pixel-coordinate / global HID (escape hatches; require --allow-hid)
stella-computer click-screenshot 840 612 --allow-hid     # uses screenshot pixels, mapped to the captured window
stella-computer click-point 500 300 --allow-hid          # global screen coords
stella-computer drag 200 400 600 400 --allow-hid
stella-computer drag-screenshot 840 612 1040 612 --allow-hid
stella-computer type "hello world" --allow-hid           # types into whatever currently has keyboard focus
stella-computer press cmd+f --allow-hid                  # sends key chord to whatever has focus

# Output controls
stella-computer snapshot --app Finder --no-screenshot
stella-computer snapshot --app Finder --no-inline-screenshot   # keep file path, skip base64
stella-computer click 4 --no-overlay                            # skip the visual cursor overlay
```

`--allow-hid` is required for global HID commands (`click-point`, `click-screenshot`, `drag*`, `type`, `press`) because they can interfere with active user input. They do **not** automatically raise the target — if the target isn't already in a state where the keystroke / coordinate would land on it (e.g. it has keyboard focus, or the screen pixel is inside its visible window), they will misfire. Prefer the AX commands.

## Common patterns

### Background playback control of a media app (Spotify, Music)

```bash
stella-computer snapshot --app Spotify
# In the menu bar block, find: 20 menu bar item Playback → 164 menu → 165 menu item Play
stella-computer secondary-action 165 AXPress
stella-computer get-state --app Spotify           # verify (window title flips to track name; menu item flips Play → Pause)
```

The window stays where it is. The user's active app does not change.

### Open a control in a normal app and type into it

```bash
stella-computer snapshot --app Notes
# Find a settable AXTextArea or AXTextField in the snapshot
stella-computer fill 34 "Note body"
```

Use `fill` (AX `set-value`) rather than `type` whenever the target element is settable — it's deterministic and doesn't depend on focus.

### Walk a menu without raising

```bash
stella-computer snapshot --app <Name>
# The menu bar root and every menu / menu item are already in the tree.
stella-computer secondary-action <menu-item-id> AXPress
```

### Switch to a non-frontmost window of the same app

```bash
stella-computer snapshot --app Finder --all-windows
stella-computer secondary-action 18 AXRaise         # raises THAT specific window of Finder
```

`AXRaise` on a window element raises that window inside its app's z-order; it doesn't take focus from the user's other apps.

### Drag a file from one Finder window to another

```bash
stella-computer snapshot --app Finder --all-windows
# 7 is a file row in window A, 31 is a folder in window B
stella-computer drag-element 7 31 --type file --operation move --allow-hid
```

## Sessions

Agent runs get an isolated default session derived from `taskId` / `runId` / `agentType`, so parallel tasks don't overwrite each other's element IDs. For manual CLI work pass `--session <name>`. State lives at `state/stella-computer/sessions/<session>/`.

## Safety rails

`stella-computer` refuses to control:

- Stella's own surfaces (`com.stella.desktop`, `com.stella.app`, `com.stella.runtime`)
- System Settings, Keychain Access, SecurityAgent, LocalAuthentication UI
- Password managers (1Password, LastPass, Bitwarden, Dashlane)
- URLs containing banking / identity-provider substrings (`appleid.apple.com`, `accounts.google.com/signin`, `chase.com/digital`, `paypal.com/signin`, `github.com/login`, …)

Extend per-process: `STELLA_COMPUTER_FORBIDDEN_BUNDLES=a,b,c` and `STELLA_COMPUTER_FORBIDDEN_URL_SUBSTRINGS=foo,bar`. After every action, Stella re-checks the resulting URL against the blocklist and surfaces a warning if it landed on a forbidden surface — treat that warning as a stop signal.

## Known limits

- Element IDs are valid only against the snapshot they came from. Re-snapshot before acting in a new turn.
- HID coordinate commands and `type` / `press` go to whatever is currently visible at that pixel / has keyboard focus, respectively. They are NOT app-targeted in the AX sense and may misfire if the target isn't on top.
- Browser tab content and parts of Electron app content can live in helper processes (OOP) and may not surface in the AX tree. Stella now exposes the menu bar of every app, which gives you a reliable background control surface even when the window AX tree is shallow.
- Default snapshot walks `--max-depth 4` / `--max-nodes 320`. For dense apps (Mail message list, Numbers spreadsheets) bump them with `--max-depth N` / `--max-nodes N`.
- macOS only.

## Backlinks

- [Skills Index](state/skills/index.md)
- [registry](state/registry.md)
- [general-agent](runtime/extensions/stella-runtime/agents/general.md)
- [implementation notes](docs/stella-computer.md)
