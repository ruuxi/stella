# stella-computer — implementation notes

This document is the architecture / implementation reference for `stella-computer`, Stella's macOS desktop automation engine. For agent-facing usage docs see [`state/knowledge/stella-computer.md`](../state/knowledge/stella-computer.md).

## Architecture

Three layers, each in its own process boundary:

```
agent runtime  ──►  shell.exec  ──►  runtime/kernel/cli/stella-computer.ts (Node)
                                            │
                                            └──►  desktop/native/out/darwin/desktop_automation (Swift CLI)
                                                       │
                                                       └──►  macOS Accessibility / ScreenCaptureKit / System Events / CGEvent
```

Each `stella-computer ...` invocation is **stateless and short-lived**: the Node wrapper loads the cached snapshot from disk, spawns the Swift binary with the right flags, parses the JSON response, and re-renders it for the agent. No daemon, no in-memory state across calls. State is durable on disk, not in RAM.

| Layer | Path | Role |
|---|---|---|
| Swift CLI | `desktop/native/src/desktop_automation.swift` | All AX, ScreenCaptureKit, System Events, CGEvent, drag-and-drop, screenshot capture and base64 encoding. Emits structured JSON. |
| Node wrapper | `runtime/kernel/cli/stella-computer.ts` | Session/state/locks management, parses Swift JSON, renders the compact text format, emits `[stella-attach-image]` markers. |
| Auto-attach hook | `runtime/kernel/agent-runtime/tool-adapters.ts` (`extractAttachImageBlocks`) | Detects `[stella-attach-image]` markers in any tool's stdout and re-attaches the referenced PNG as a vision content block on the next assistant turn. |

The Swift binary builds via `desktop/native/build.sh` (raw `swiftc -O`) — no Xcode project, no SwiftPM. Linked frameworks: `ApplicationServices`, `AppKit`, `Carbon`, `CoreGraphics`, `Foundation`, `OSAKit`, `ScreenCaptureKit`.

## Output format

Snapshot/action results are rendered as a compact tree designed for low token cost and easy pattern-matching by the model.

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
[stella-attach-image] 2174x1142 243KB inline=image/png /path/to/last-snapshot.png

--- App-specific instructions ---
# Finder Computer Use
- Sidebar entries are AXRow rows under an AXOutline; click to navigate.
- ...
--- end app-specific instructions ---
```

Format rules:

- One node per line, tab-indented, `<ref> <role> [(<state-flags>)] <label>[, Secondary Actions: a, b, c][, ID: ...][, URL: ...]`.
- AX role names are stripped of `AX` and lowercased (`AXScrollArea` → `scroll area`).
- State flags inside `(...)`: `disabled`, `selected`, `focused` (only those that apply).
- `AXPress` is implicit on every clickable node and is hidden from the Secondary Actions list; everything else (e.g. `open`, `AXShowMenu`, `AXCancel`, `AXPick`) is surfaced.
- Refs use the `@d<N>` namespace (sequential per snapshot). The prefix exists for unambiguous CLI parsing — `stella-computer click @d12` is unambiguous, `click 12` is not.

The trailing `[stella-attach-image]` line carries `<width>x<height>` plus `<bytes>KB` plus `inline=image/png` (when base64 was included) plus the file path. The runtime auto-attach hook reads this line, slurps the PNG, and emits an `image` content block alongside the text — meaning the model sees the screenshot on its very next turn without an extra `Read` tool call.

## Ref matching algorithm

Refs are not stable handles to AX elements; the AX object identity dies when the tree mutates. Each action call (`click`, `fill`, `focus`, `secondary-action`, `scroll`, `drag-element`) re-walks the live AX tree and rematches the saved ref using a multi-feature scoring function.

Inputs to the score (from `RefEntry` saved at snapshot time vs. live `CandidateNode`):

- `role` (gate — mismatch returns `Int.min`)
- `identifier` (exact 150 / contains 70 / token-similarity up to 24)
- `primaryLabel` (95 / 40 / 34, plus a 10-pt contains bonus)
- `title`, `description`, `value`, `subrole`, `windowTitle` (smaller weights)
- `childPath` (full match 72 + per-prefix-element 14, length-mismatch penalty)
- `ancestry` prefix length (4 per element)
- `frame` (center-distance + size-distance, capped at 30)
- shared action overlap (10)
- enabled / focused / selected match (6 each, only when both sides have the value)
- `identifier + primaryLabel` simultaneous exact match: extra 60 super-bonus

Acceptance is **percentile-based**, not absolute:

1. `maxPossibleScore(entry)` is computed based on which fields the saved ref actually has populated. A thin ref with no identifier and no label has a much smaller ceiling than a fully-populated one.
2. The best candidate must clear `STELLA_COMPUTER_MIN_CONFIDENCE` (default `0.30`) of that ceiling.
3. The gap between best and second-best must clear `STELLA_COMPUTER_MIN_GAP` (default `0.07`) of the ceiling.
4. Both checks are bypassed if a "stable exact" match exists: `identifier == identifier`, `url == url`, or `(primaryLabel + childPath)` exact, or `(primaryLabel + frame)` close.
5. Otherwise the action fails with either `Failed to resolve <ref>` (no candidate cleared the floor) or `Ambiguous match for <ref>` (best vs. second-best gap too small) — both with the percentile printed in the warning.

Tolerating small UI mutations between snapshot and action while still refusing to guess when the gap is too thin is the whole point: a fuzzy ranked match is more robust than a deterministic match-or-fail at the cost of a small confidence warning when matching is uncertain.

When the original target pid has died, Stella revalidates via `NSWorkspace.shared.runningApplications`. If a same-bundle process is still running, it transparently rebinds and re-runs the candidate match (which is structural, not pid-bound). If the bundle is fully gone, it surfaces `Target app '...' (pid X) is no longer running.`

## Snapshot capture pipeline

```
1. resolveTarget(pid|appName|bundleId) → AppTarget (NSRunningApplication + AXUIElement)
2. ensureTargetAllowed(target)            → reject hardcoded forbidden bundles
3. configureMessagingTimeout(target)
   - AXUIElementSetMessagingTimeout(app, 0.5s)         (one-time per pid)
   - AXManualAccessibility = true on Electron/Chromium frameworks
   - AXEnhancedUserInterface = true                    (one-time per pid)
4. roots = snapshotRoots(app) | allWindowRoots(app) if --all-windows
5. SnapshotBuilder.buildNode walk:
   - cycle detection via CFHash visited set
   - 1st batched read: role + title + focused + value + url   (cheap "deciding" set)
   - if actionable, 2nd batched read: subrole + description + identifier + enabled + selected + position + size
   - axChildren(role): AXVisibleChildren ∪ AXContents ∪ role-specific arrays ∪ kAXChildren
   - assigns sequential refs (@d1, @d2, ...) for actionable nodes only
6. captureScreenshot(rect, pid, includeBase64=true):
   - SCK path (macOS 14+): SCShareableContent → largest on-screen window for pid
     → SCContentFilter(desktopIndependentWindow) → SCStreamConfiguration with pointPixelScale
     → SCScreenshotManager.captureImage → PNG
   - Fallback: /usr/sbin/screencapture -x [-R x,y,w,h] /path
   - Returns Screenshot{mimeType, base64, path, widthPx, heightPx, byteCount}
7. Write SnapshotDocument JSON to statePath; emit on stdout.
```

Two-tier batched reads matter: a normal Finder window walks 200-300 nodes; without tier gating you'd pay ~6 AX RPCs per static-text leaf even though we don't need them. With tier gating, leaves cost 1 batched call and only actionable nodes pay the deep read.

## Action dispatch

| CLI tool | AX-first path | HID fallback |
|---|---|---|
| `click <ref>` | `AXUIElementPerformAction(elem, kAXPressAction)` | `runSystemEventsOnTarget` `click at {x,y}` → CGEvent leftMouseDown/Up |
| `secondary-action <ref> <action>` | `AXUIElementPerformAction(elem, action)` (validated against `AXUIElementCopyActionNames`) | none |
| `fill <ref> <text>` | `AXUIElementSetAttributeValue(elem, kAXValueAttribute, text)` (string then numeric coercion); on `.success` with mismatched readback returns `AXValue(transformed)` early — does NOT fall through to keystroke (avoids double-edit on Numbers etc.) | `cmd+a` + `delete` + System Events `keystroke` chunked at 200 chars |
| `focus <ref>` | `AXUIElementSetAttributeValue(elem, kAXFocusedAttribute, true)` | none |
| `scroll <ref> <dir> [--pages N]` | `AXUIElementPerformAction(elem, kAXScroll{Up,Down,Left,Right}ByPageAction)` × N | none |
| `type <text> --allow-hid` | (no AX path — the AX target is implied focus) | System Events `keystroke` (chunked) → CGEvent unicode keyboardEvent |
| `press <key> --allow-hid` | (no AX path) | System Events `key code <N> using {modifiers}` → CGEvent keyboardEvent |
| `click-point <x> <y> --allow-hid` | (no AX path) | System Events `click at {x,y}` → CGEvent left mouseDown/Up |
| `drag <fx> <fy> <tx> <ty> --allow-hid` | none — coordinate-only | CGEvent leftMouseDown/Dragged/Up sequence with linear stepping |
| `drag-element <src-ref> <dest> --allow-hid` | NSDraggingSession with overlay panel hosting `DragSourceView : NSDraggingSource`. Pasteboard payload extracted from source AX element (`AXURL` for Finder/browser items, AXValue for text fields). Cursor driven from src to dest with synthesized `leftMouseDragged` events. | none — only mode |

System Events delivery uses `NSAppleScript` in-process (compiled scripts cached in `compiledScriptCache`) with `tell application "System Events" / tell first process whose unix id is <pid>` preamble. `STELLA_COMPUTER_NO_RAISE=1` (or `--no-raise`) suppresses the `set frontmost to true` step so background automation doesn't yank focus.

`STELLA_COMPUTER_ALWAYS_SIMULATE_INPUT=1` (alias `STELLA_COMPUTER_ALWAYS_SIMULATE_CLICK=1`) forces the CGEvent path for click/type/press regardless of AX availability.

## Auto-attach screenshot pipeline

`runtime/kernel/agent-runtime/tool-adapters.ts::extractAttachImageBlocks(text)` runs on every tool's `formatToolResult.text` before it reaches the model:

1. Regex-detect lines matching `^\[stella-attach-image\][^\n]*?\s(\/[^\s\n]+\.(png|jpg|jpeg|gif|webp))\s*$`.
2. Read the referenced file with `fs.readFile`.
3. Emit one `image` content block per match: `{ type: "image", mimeType, data: base64 }`.
4. Strip the marker line(s) from the forwarded text so the model doesn't waste tokens on the path.
5. If any file is missing (deleted between CLI exit and our read), leave the marker visible so the model can see what was attempted.

The hook is wired into the generic per-tool `execute` adapter, so any future CLI that emits `[stella-attach-image] <path>` markers participates without further code changes. Today only `stella-computer` does.

The Anthropic provider (`runtime/ai/providers/anthropic.ts::convertContentBlocks`) already handles `(TextContent | ImageContent)[]` arrays in tool results — Anthropic's `tool_result.content` natively supports image blocks. Google + OpenAI providers similarly accept image content; we don't need provider changes.

## Per-app operator instructions

Bundled markdown lives in the Swift binary itself (`bundledAppInstructions: [String: String]`) keyed by bundle id. When `snapshot` resolves to `com.apple.finder`, `com.apple.Notes`, `com.apple.iCal`, `com.apple.MobileSMS`, `com.apple.Safari`, or `com.apple.MobileSafari`, the matching markdown is appended to the result under `--- App-specific instructions ---` markers.

`STELLA_COMPUTER_APP_INSTRUCTIONS_DIR=<dir>` enables loose markdown overlays: a file at `<dir>/<bundle-id>.md` overrides or extends the bundled set. Used to add per-app guidance without rebuilding the binary.

## Safety rails

| Layer | Where | Override |
|---|---|---|
| Hardcoded forbidden bundle ids | `baseForbiddenBundleIdentifiers` in Swift | `STELLA_COMPUTER_FORBIDDEN_BUNDLES=a,b,c` (extends only — base set always applies) |
| Hardcoded forbidden URL substrings | `baseForbiddenUrlSubstrings` in Swift | `STELLA_COMPUTER_FORBIDDEN_URL_SUBSTRINGS=foo,bar` (extends only) |
| Pre-action URL check | inside `actionCandidate` — fails immediately if the saved ref's URL matches | (covered by env override) |
| Post-action URL check | inside `refreshSnapshotAfterAction` — walks the refreshed snapshot looking for a focused/window-root URL match, surfaces a loud warning. Doesn't undo the action; the agent is expected to step back. | (covered by env override) |
| HID gate | `--allow-hid` flag or `STELLA_COMPUTER_ALLOW_HID=1` env var — required for `drag`, `drag-element`, `click-point`, `type`, `press`, and `click --coordinate-fallback`. | none — explicit opt-in only |

Base forbidden bundles include Stella's own surfaces (defense-in-depth: `com.stella.desktop`, `com.stella.app`, `com.stella.runtime`), system security surfaces (`com.apple.systempreferences`, `com.apple.SystemSettings`, `com.apple.keychainaccess`, `com.apple.SecurityAgent`, `com.apple.LocalAuthentication.UIAgent`), and common password managers (1Password, LastPass, Bitwarden, Dashlane).

Base forbidden URL substrings cover banking + identity-provider sign-in surfaces (`accounts.google.com/signin`, `appleid.apple.com`, `login.microsoftonline.com`, `secure.bankofamerica.com`, `wellsfargo.com/online-banking`, `chase.com/digital`, `paypal.com/signin`, `stripe.com/login`, `github.com/login`, `auth0.com/login`, `okta.com/login`).

## Session and locking

- Default state file: `state/stella-computer/sessions/<sessionId>/last-snapshot.json`
- Default screenshot: `state/stella-computer/sessions/<sessionId>/last-snapshot.png`
- `sessionId` derived from `taskId → runId → rootRunId → requestId → conversationId` plus an `agentType-` prefix; kebab-cased + capped at 120 chars by `sanitizeStellaComputerSessionId`.
- Manual CLI runs default to `--session manual`.
- Per-target file locks live under `state/stella-computer/locks/<key>/`; key derives from app/bundle/pid plus a `global-hid` lock for HID-injecting commands so only one such fallback runs at a time.
- Stale-lock cleanup at 90s, configurable via `STELLA_COMPUTER_LOCK_TIMEOUT_MS`.

## Snapshot diagnostics

`AxDiagnostics.shared` (per-process singleton, reset between commands) tracks:

- `oopHits` — count of `cannotComplete` AX errors (typically Out-Of-Process elements in browsers / Electron)
- `transientRetries` — count of retry-on-`cannotComplete` attempts that eventually succeeded

`oopHits > 0` surfaces a warning in the response: "Some elements live in helper processes (OOP) and could not be inspected directly (N attribute reads)."

Failed actions auto-capture a "what the screen looked like at the failure moment" PNG via `failureWithScreenshot`; the path is returned in the error envelope's `screenshotPath` and inlined as a `[stella-attach-image]` marker on stderr.

## Files

| Path | Notes |
|---|---|
| `desktop/native/src/desktop_automation.swift` | Swift CLI, ~3700 lines |
| `desktop/native/build.sh` | `swiftc -O` invocation; links the frameworks above |
| `runtime/kernel/cli/stella-computer.ts` | Node wrapper: session/state/lock management, compact-tree rendering, `[stella-attach-image]` marker emission |
| `runtime/kernel/cli/native-helper.ts` | Shared spawn helper for native binaries |
| `runtime/kernel/tools/stella-computer-session.ts` | Session id derivation from `ToolContext` |
| `runtime/kernel/tools/shell.ts` | Wires `stella-computer` Bash function alias when the CLI path is configured |
| `runtime/kernel/agent-runtime/tool-adapters.ts` | `extractAttachImageBlocks` auto-attach hook + the per-tool wrap that calls it |
| `state/knowledge/stella-computer.md` | Agent-facing operator manual (the doc to read for "how do I use this") |

## Verified behavior

Locally verified in Stella:

- Finder snapshot with default screenshot attach
- Ref-based `fill` on Finder's search field
- `list-apps` discovery + frontmost-first sort
- `secondary-action @d8 AXRaise` against a live Finder window
- Stale-snapshot ref rematching: an older snapshot file resolves the current Finder search field and refreshes its own screenshot/state
- Timeout protection: wedged native helper calls return a bounded error instead of trapping the CLI
- `extractAttachImageBlocks` unit-tested for: passthrough, single-PNG extraction, missing-file fallback, non-image-extension rejection, MIME inference

Known weak spots:

- `scroll` is implemented but some apps don't expose `kAXScroll{Up,Down,Left,Right}ByPageAction`; falls back to a no-op with a warning naming the missing AX action.
- `drag-element` only works on elements that expose a draggable payload (AXURL or settable AXValue); splitter / slider drag must use the raw `drag` coordinate path.
- Some apps expose incomplete or stale AX trees; prefer a fresh snapshot before retrying when ref resolution fails.
