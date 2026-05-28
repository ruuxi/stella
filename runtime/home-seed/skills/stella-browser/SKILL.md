---
name: stella-browser
description: Browser automation through Stella's Chrome extension bridge. Use when the agent needs to control the user's real browser tabs, navigate sites, click and type, inspect pages, download files, or capture screenshots.
---

# Browser Automation with stella-browser

Stella uses the user's actual Chrome browser through the extension bridge.

## Capability Highlights

`stella-browser` includes first-class commands for:

- Rich editor input: focus/click the editor, then use `stella-browser keyboard inserttext "..."` for paste-like insertion or `stella-browser keyboard type "..."` when key events matter.
- Robust locators: `stella-browser find role|text|label|placeholder|testid|first|last|nth ...`.
- Page evaluation: `stella-browser eval`, `eval -b`, and `eval --stdin`.
- Uploads, downloads, waits, dialogs, frames, browser settings, console logs, page errors, network requests, cookies, storage, screenshots, and PDF capture.
- Post-submit verification: wait for the expected URL/text/function, then inspect page state, console/errors, and relevant network requests.

## Tool usage

Run the CLI through `exec_command`:

```json
{ "cmd": "stella-browser open https://example.com" }
```

Then snapshot:

```json
{ "cmd": "stella-browser snapshot -i" }
```

Stella auto-injects `stella-browser` into the shell PATH, so no setup or env wiring is required.

## Extension Mode Workflow

Every browser automation follows this pattern:

1. **Navigate**: `stella-browser open <url>`
2. **Snapshot**: `stella-browser snapshot -i` to get refs like `@e1`
3. **Interact**: Click, fill, type, scroll, or select using refs
4. **Re-snapshot**: After navigation or large DOM changes, refresh refs

```bash
stella-browser open https://example.com/form
stella-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

stella-browser fill @e1 "user@example.com"
stella-browser fill @e2 "password123"
stella-browser click @e3
stella-browser wait 2000
stella-browser snapshot -i
```

## Shared Browser Model

- Stella reuses one shared tab group in the user's browser across tasks.
- Each task gets its own logical tab(s) inside that group.
- Stella works with the browser's existing logged-in state.
- Stale task tabs are cleaned up automatically over time.

## Supported Commands

```bash
# Navigation
stella-browser open <url>
stella-browser back
stella-browser forward
stella-browser reload
stella-browser close

# Snapshot
stella-browser snapshot -i
stella-browser snapshot -i -C
stella-browser snapshot --compact --depth 5
stella-browser snapshot -s "#selector"

# Interaction
stella-browser click @e1
stella-browser dblclick @e1
stella-browser focus @e1
stella-browser fill @e2 "text"
stella-browser type @e2 "text"
stella-browser press Enter
stella-browser keydown Shift
stella-browser keyup Shift
stella-browser hover @e1
stella-browser check @e1
stella-browser uncheck @e1
stella-browser select @e1 "option"
stella-browser scroll down 500
stella-browser scroll down 500 --selector ".scroll-container"
stella-browser scrollintoview @e1
stella-browser drag @e1 @e2
stella-browser upload @e3 ./file.pdf ./image.png

# Current-focus keyboard input
stella-browser keyboard type "typed with key events"
stella-browser keyboard inserttext "paste-like text for rich editors"

# Page info
stella-browser get text @e1
stella-browser get html @e1
stella-browser get value @e1
stella-browser get attr @e1 href
stella-browser get title
stella-browser get url
stella-browser get count ".item"
stella-browser get box @e1
stella-browser get styles @e1
stella-browser is visible @e1
stella-browser is enabled @e1
stella-browser is checked @e1
stella-browser set viewport 1440 900
stella-browser set media dark
stella-browser set offline on

# Semantic locators
stella-browser find role button click --name Submit
stella-browser find label "Email" fill "user@example.com"
stella-browser find placeholder "Search..." type "query"
stella-browser find text "Continue" click --exact
stella-browser find testid "login-form" click
stella-browser find nth 2 ".card" hover

# Wait and capture
stella-browser wait @e1
stella-browser wait --text "Success"
stella-browser wait --url "**/page"
stella-browser wait --fn "window.appReady === true"
stella-browser wait --download ./file.pdf --timeout 30000
stella-browser wait 2000
stella-browser screenshot
stella-browser screenshot --full
stella-browser screenshot --annotate
stella-browser screenshot @e1 ./element.png
stella-browser pdf output.pdf
stella-browser download @e4 ./file.pdf

# Tabs, frames, dialogs, storage, network, utilities
stella-browser tab
stella-browser tab new https://example.com
stella-browser window new
stella-browser tab 2
stella-browser tab close
stella-browser frame "#embedded-frame"
stella-browser frame main
stella-browser dialog accept
stella-browser dialog dismiss
stella-browser cookies
stella-browser cookies get --url https://example.com
stella-browser cookies set session_id "abc123" --url https://example.com
stella-browser cookies clear
stella-browser storage local
stella-browser storage local get authToken
stella-browser storage local set theme "dark"
stella-browser storage local clear
stella-browser storage session
stella-browser network requests --clear
stella-browser network requests --filter "api"
stella-browser network route "**/api/*" --abort
stella-browser network route "**/data.json" --body '{"mock":true}'
stella-browser network unroute
stella-browser clipboard read
stella-browser clipboard write "Hello"
stella-browser clipboard copy
stella-browser clipboard paste
stella-browser mouse move 100 200
stella-browser mouse wheel 100
stella-browser eval "document.title"
stella-browser eval --stdin
stella-browser console
stella-browser errors
stella-browser highlight @e1
```

## Common Patterns

### Form Submission

```bash
stella-browser open https://example.com/signup
stella-browser snapshot -i
stella-browser fill @e1 "Jane Doe"
stella-browser fill @e2 "jane@example.com"
stella-browser select @e3 "California"
stella-browser check @e4
stella-browser click @e5
stella-browser wait --url "**/thank-you"
```

### Work With Existing Login State

```bash
# Stella uses the user's existing browser profile and cookies.
# If the user is already signed in, navigate directly to the target page.
stella-browser open https://app.example.com/dashboard
stella-browser snapshot -i
```

### Data Extraction

```bash
stella-browser open https://example.com/products
stella-browser snapshot -i
stella-browser get text @e5
stella-browser get text body > page.txt

# JSON output for parsing
stella-browser snapshot -i --json
stella-browser get text @e1 --json
```

### Downloads

```bash
stella-browser open https://example.com/reports
stella-browser snapshot -i
stella-browser download @e5 ./report.csv
```

### Rich Editors and Large Text

Use the keyboard command for contenteditable editors such as Lexical, ProseMirror, CodeMirror, Monaco, Docs-style editors, and chat composers.

```bash
stella-browser snapshot -i -C
stella-browser click "[contenteditable]"
stella-browser keyboard inserttext "# Heading

Long pasted body text..."
stella-browser press Enter
stella-browser keyboard type "A final line that needs key events"
```

### Semantic Locators

Use `find` with accessible names, labels, placeholder text, or test IDs.

```bash
stella-browser find role button click --name Submit
stella-browser find label "Email" fill "jane@example.com"
stella-browser find placeholder "Search..." type "quarterly report"
stella-browser find text "Done" click --exact
stella-browser find first ".result-row" click
```

### JavaScript Evaluation

Use `eval --stdin` or `eval -b` for multiline or quote-heavy scripts. Use `--json` when the result will be parsed.

```bash
stella-browser eval "document.title"
stella-browser eval --json "Array.from(document.links).map(a => a.href)"

stella-browser eval --stdin <<'EOF'
const rows = [...document.querySelectorAll('[data-row]')];
rows.map((row) => row.innerText.trim());
EOF
```

### Uploads

```bash
stella-browser snapshot -i
stella-browser upload @e3 ./proposal.pdf ./cover.png
stella-browser wait --text "Upload complete"
```

### Submit and Verify

Post-submit checks can combine page state and diagnostics.

```bash
stella-browser network requests --clear
stella-browser click @e5
stella-browser wait --url "**/thank-you"
stella-browser wait --text "Thanks"
stella-browser errors
stella-browser console
stella-browser network requests --filter "api" --json
```

## Ref Lifecycle

Refs (`@e1`, `@e2`, etc.) are invalidated when the page changes. Always re-snapshot after:

- Clicking links or buttons that navigate
- Form submissions
- Dynamic content loading such as dropdowns or modals

```bash
stella-browser click @e5
stella-browser snapshot -i
stella-browser click @e1
```

## Reference Docs


| Reference                                                                  | When to Use                                        |
| -------------------------------------------------------------------------- | -------------------------------------------------- |
| [references/commands.md](references/commands.md)           | Supported extension-backed command surface         |
| [references/snapshot-refs.md](references/snapshot-refs.md) | Ref lifecycle, invalidation rules, troubleshooting |


## Ready-to-Use Templates


| Template                                                                       | Description                         |
| ------------------------------------------------------------------------------ | ----------------------------------- |
| [templates/form-automation.sh](templates/form-automation.sh)   | Form filling with validation        |
| [templates/capture-workflow.sh](templates/capture-workflow.sh) | Content extraction with screenshots |


```bash
./templates/form-automation.sh https://example.com/form
./templates/capture-workflow.sh https://example.com ./output
```
