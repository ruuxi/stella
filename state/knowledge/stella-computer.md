---
name: stella-computer
description: macOS desktop automation for arbitrary apps through Accessibility-first refs, with compact snapshots and auto-attached screenshots.
---

# Desktop Automation with stella-computer

Use `stella-computer` for arbitrary macOS apps outside Stella itself (Finder, Notes, Calendar, Mail, Messages, Safari, third-party apps, etc.). It talks to macOS Accessibility first, so `click`, `fill`, `focus`, `secondary-action`, and `scroll` work without taking over the user's physical cursor.

For Stella's own running UI use `stella-ui` instead. For browser content use `stella-browser` (DOM-level access via the extension bridge). Use `stella-computer` for everything else on the desktop.

## Core Workflow

Every desktop automation follows the same shape:

1. **Discover** which app to target (only when you don't already know): `stella-computer list-apps`
2. **Snapshot** the target to get refs like `@d1`: `stella-computer snapshot --app Finder`
3. **Interact** through refs: `click`, `fill`, `focus`, `secondary-action`, `scroll`
4. **Re-snapshot** is automatic — every successful action refreshes refs + screenshot

```bash
stella-computer list-apps
stella-computer snapshot --app Finder
stella-computer fill @d9 "search text"
stella-computer click @d4
```

The snapshot screenshot is auto-attached as a vision content block on your next turn. **Do not run a separate Read for the screenshot path** — the image is already in your context.

## Reading a snapshot

The snapshot output is a compact tree of actionable accessibility nodes:

```
<stella_computer_state>
App=com.apple.finder (pid 504)
Window: "Desktop", App: Finder.
@d1 scroll area (disabled) desktop
	@d2 group desktop
		@d3 image Screenshot 2026-04-13 at 12.10.39 AM, Secondary Actions: open
@d5 menu bar
	@d6 menu bar item Finder
	@d7 menu bar item File
	@d8 menu bar item (focused) Edit
The focused UI element is @d8.
</stella_computer_state>
```

- One node per line, tab-indented.
- `<ref> <role> [(<state-flags>)] <label>[, Secondary Actions: a, b, c][, ID: ...][, URL: ...]`
- AX role names are stripped of `AX` and lowercased.
- State flags only show when set: `disabled`, `selected`, `focused`.
- `AXPress` (regular click) is implicit; only the *other* secondary actions are listed.
- Use the leading `@d<N>` token as the ref for action commands.

After the state block, look for an `--- App-specific instructions ---` section. When you target Finder, Notes, Calendar, Messages, or Safari, Stella appends per-app guidance there. Read it before acting; it documents app-specific gotchas (e.g. "do not call set-value on Finder filename rows unless the user explicitly asked to rename a file").

## Supported Commands

```bash
# App discovery
stella-computer list-apps

# Snapshot (refs + screenshot + per-app instructions)
stella-computer snapshot --app Finder
stella-computer snapshot --bundle-id com.apple.Notes
stella-computer snapshot --pid 504
stella-computer snapshot --app Finder --all-windows
stella-computer snapshot --app Finder --max-depth 6 --max-nodes 800

# Ref-based interaction (Accessibility-first; no HID required)
stella-computer click @d4
stella-computer fill @d9 "search text"
stella-computer focus @d12
stella-computer secondary-action @d8 AXShowMenu
stella-computer secondary-action @d8 AXRaise
stella-computer scroll @d23 down
stella-computer scroll @d23 down --pages 3

# Content drag-and-drop (NSDraggingSession; uses the source AX element's pasteboard payload)
stella-computer drag-element @d7 @d12 --allow-hid
stella-computer drag-element @d7 --to-x 600 --to-y 400 --type file --allow-hid

# HID fallbacks (require --allow-hid; act on whatever has focus)
stella-computer type "hello world" --allow-hid
stella-computer press cmd+f --allow-hid
stella-computer press return --allow-hid
stella-computer click-point 500 300 --allow-hid
stella-computer drag 200 400 600 400 --allow-hid
stella-computer click @d4 --coordinate-fallback --allow-hid

# Session and output controls
stella-computer --session my-task snapshot --app Finder
stella-computer snapshot --app Finder --no-screenshot
stella-computer snapshot --app Finder --no-inline-screenshot   # keep file path, skip base64
stella-computer click @d4 --no-raise                            # don't bring app frontmost
stella-computer click @d4 --no-overlay                          # skip the lens + cursor visual overlay
```

## Visual overlay

By default every ref-based action (`click`, `fill`, `focus`, `secondary-action`, `scroll`) shows a brief lens + software-cursor overlay around the target element so the user can see what Stella is acting on. The overlay fades in, holds for a beat while the action executes, then fades out — about 700ms total per action. Pass `--no-overlay` (or set `STELLA_COMPUTER_NO_OVERLAY=1`) to skip it when chained-action latency matters more than visual feedback.

## Common Patterns

### Open an app, find a control, type into it

```bash
stella-computer list-apps                               # confirm Finder is running
stella-computer snapshot --app Finder
stella-computer press cmd+f --allow-hid                 # open the search field
stella-computer snapshot --app Finder                   # refs change after switching to search
stella-computer fill @d34 "annual report.pdf"           # @d34 is the search text field in the new snapshot
```

### Click a menu item via the menu bar

```bash
stella-computer snapshot --app Finder
stella-computer click @d6                                # the "File" menu bar item
stella-computer snapshot --app Finder                    # menu items appear as new refs
stella-computer click @d44                               # "New Folder"
```

### Switch focus to a non-frontmost window

```bash
stella-computer snapshot --app Finder --all-windows      # see every window, not just the focused one
stella-computer secondary-action @d18 AXRaise            # bring that specific window to front
```

### Drag a file from one Finder window to another

```bash
stella-computer snapshot --app Finder --all-windows
# @d7 is a file row in window A, @d31 is a folder in window B
stella-computer drag-element @d7 @d31 --type file --operation move --allow-hid
```

### Set a slider / splitter value directly

```bash
stella-computer snapshot --app Finder
stella-computer fill @d22 "200"                          # @d22 is the AXSplitter; numeric coercion happens automatically
```

### Select rows with the keyboard after focusing a list

```bash
stella-computer snapshot --app Finder
stella-computer focus @d34                               # row in the list view
stella-computer press down --allow-hid                   # arrow-key navigation
stella-computer press down --allow-hid
```

## Sessions

Agent and task runs get an isolated default session automatically (derived from `taskId`/`runId`/`agentType`), so parallel agents do not overwrite each other's refs. For manual CLI work or when you want explicit isolation, pass `--session <name>`:

```bash
stella-computer --session research-1 snapshot --app Finder
stella-computer --session research-1 click @d4
stella-computer --session research-2 snapshot --app Notes   # separate state file, separate refs
```

State lives at `state/stella-computer/sessions/<session>/last-snapshot.json` and `last-snapshot.png`.

## Safety Rails

Stella refuses to control its own surfaces, system security UI, password managers, and identity-provider sign-in pages by default. The hardcoded denylist covers:

- Stella's own bundles (`com.stella.desktop`, `com.stella.app`, `com.stella.runtime`)
- System Settings, Keychain Access, SecurityAgent, LocalAuthentication UI
- 1Password, LastPass, Bitwarden, Dashlane
- Banking + identity-provider URL substrings (`appleid.apple.com`, `accounts.google.com/signin`, `chase.com/digital`, `paypal.com/signin`, `github.com/login`, etc.)

Extend the lists when needed:

```bash
STELLA_COMPUTER_FORBIDDEN_BUNDLES=com.example.app stella-computer ...
STELLA_COMPUTER_FORBIDDEN_URL_SUBSTRINGS=internal-finance.example.com stella-computer ...
```

After every successful action Stella re-checks the resulting URL against the blocklist and surfaces a warning if it landed on a forbidden surface. Treat that warning as a stop signal; back out manually rather than continuing to act.

## When to use which command

Prefer ref-based commands first — they use macOS Accessibility and don't move the user's cursor:

- `click`, `fill`, `focus`, `secondary-action`, `scroll`, `drag-element`

Use HID fallbacks (`--allow-hid` required) only when ref-based actions don't reach the target:

- `type` / `press` — when text needs to land in whatever has focus, not in a specific ref
- `click-point` / `drag` / `click --coordinate-fallback` — when the target has no AX representation (custom-drawn surfaces, OOP browser content, splitters)

If `secondary-action` reports "Action X is not available for @dN", read the available actions from the failure warning and pick one that's listed; the AX node only honors the actions it advertises.

## Known Limits

- `drag` is coordinate-only HID. For content-bearing drag-and-drop (file move, link drop, text drop), use `drag-element` — it extracts the right pasteboard type from the source AX element so the destination app sees a real drop.
- `drag-element` requires the source element to expose a draggable payload (`AXURL` for Finder/browser items, `AXValue` for text fields). Splitters, sliders, and pure-visual elements have no payload — fall back to coordinate `drag`.
- Browser tab content + Electron app content live in helper processes and may not surface in the AX tree (you'll see an "Some elements live in helper processes (OOP)" warning). For DOM-level access prefer `stella-browser`.
- Some apps expose stale or incomplete AX data; if a ref fails to resolve with an "ambiguous match" or "could not find" warning, take a fresh snapshot and try again.
- The CLI walks at `--max-depth 4` / `--max-nodes 320` by default. For dense apps (Mail message list, Numbers spreadsheets) you may need to bump these.
- `stella-computer` is macOS-only.

## Backlinks

- [knowledge-index](state/knowledge/index.md)
- [registry](state/registry.md)
- [general-agent](runtime/extensions/stella-runtime/agents/general.md)
- [implementation notes](docs/stella-computer.md)
