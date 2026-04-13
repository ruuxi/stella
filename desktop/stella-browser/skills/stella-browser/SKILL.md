---

## name: stella-browser

description: Browser automation through Stella's Chrome extension bridge. Use when the agent needs to control the user's real browser tabs, navigate sites, click and type, inspect pages, download files, or capture screenshots without launching a separate automation browser.
allowed-tools: Bash(stella-browser:*)

# Browser Automation with stella-browser

Stella uses the user's actual Chrome browser through the extension bridge. It does not rely on separate browser installs, proxy workflows, auth vaults, isolated automation sessions, or iOS/Appium providers for normal browser tasks.

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
stella-browser wait --load networkidle
stella-browser snapshot -i
```

## Shared Browser Model

- Stella reuses one shared tab group in the user's browser across tasks.
- Each task gets its own logical tab(s) inside that group.
- Stella works with the browser's existing logged-in state instead of storing separate Stella auth sessions.
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
stella-browser scrollintoview @e1
stella-browser drag @e1 @e2

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

# Wait and capture
stella-browser wait @e1
stella-browser wait --load networkidle
stella-browser wait --url "**/page"
stella-browser wait 2000
stella-browser screenshot
stella-browser screenshot --full
stella-browser pdf output.pdf
stella-browser download @e4 ./file.pdf

# Tabs, storage, network, utilities
stella-browser tab
stella-browser tab new https://example.com
stella-browser tab close
stella-browser cookies
stella-browser cookies clear
stella-browser storage local
stella-browser storage session
stella-browser network requests --filter "api"
stella-browser network route "**/api/*" --abort
stella-browser clipboard read
stella-browser mouse move 100 200
stella-browser eval "document.title"
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
stella-browser wait --load networkidle
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

| Reference                                                  | When to Use                                        |
| ---------------------------------------------------------- | -------------------------------------------------- |
| [references/commands.md](stella-browser/skills/stella-browser/references/commands.md)           | Supported extension-backed command surface         |
| [references/snapshot-refs.md](stella-browser/skills/stella-browser/references/snapshot-refs.md) | Ref lifecycle, invalidation rules, troubleshooting |

## Ready-to-Use Templates

| Template                                                       | Description                         |
| -------------------------------------------------------------- | ----------------------------------- |
| [templates/form-automation.sh](stella-browser/skills/stella-browser/templates/form-automation.sh)   | Form filling with validation        |
| [templates/capture-workflow.sh](stella-browser/skills/stella-browser/templates/capture-workflow.sh) | Content extraction with screenshots |

```bash
./templates/form-automation.sh https://example.com/form
./templates/capture-workflow.sh https://example.com ./output
```
