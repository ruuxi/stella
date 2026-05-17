# Command Reference

Supported `stella-browser` commands for Stella's extension-backed browser mode. For the normal workflow, see [SKILL.md](stella-browser/skills/stella-browser/SKILL.md).

Stella uses the user's real Chrome browser through the extension bridge.

## Navigation

```bash
stella-browser open <url>      # Navigate to URL
stella-browser back            # Go back
stella-browser forward         # Go forward
stella-browser reload          # Reload page
stella-browser close           # Close the shared Stella browser window
```

## Snapshot

```bash
stella-browser snapshot            # Full accessibility tree
stella-browser snapshot -i         # Interactive elements only
stella-browser snapshot -i -C      # Include cursor-interactive elements
stella-browser snapshot -c         # Compact output
stella-browser snapshot -d 3       # Limit depth to 3
stella-browser snapshot -s "#main" # Scope to CSS selector
```

## Interaction

```bash
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
stella-browser select @e1 "value"
stella-browser select @e1 "a" "b"
stella-browser scroll down 500
stella-browser scroll down 500 --selector ".scroll-container"
stella-browser scrollintoview @e1
stella-browser drag @e1 @e2
stella-browser upload @e1 ./file.pdf ./image.png
```

## Keyboard

```bash
stella-browser press Enter
stella-browser press Control+a
stella-browser keydown Shift
stella-browser keyup Shift
stella-browser keyboard type "text with key events"
stella-browser keyboard inserttext "paste-like text for rich editors"
```

`keyboard inserttext` inserts into the current focus without requiring a selector. `keyboard type` sends actual per-character key events.

## Semantic Locators

```bash
stella-browser find role button click --name Submit
stella-browser find role button click --name Submit --exact
stella-browser find text "Continue" click
stella-browser find text "Continue" click --exact
stella-browser find label "Email" fill "user@example.com"
stella-browser find placeholder "Search..." type "query"
stella-browser find alt "Product image" click
stella-browser find title "Close" click
stella-browser find testid "login-form" click
stella-browser find first ".result-row" click
stella-browser find last ".toast" hover
stella-browser find nth 2 ".card" focus
```

Supported locator actions: `click`, `fill`, `type`, `hover`, `focus`, `check`, `uncheck`.

## Get Information

```bash
stella-browser get text @e1
stella-browser get html @e1
stella-browser get value @e1
stella-browser get attr @e1 href
stella-browser get title
stella-browser get url
stella-browser get count ".item"
stella-browser get box @e1
stella-browser get styles @e1
```

## Check State

```bash
stella-browser is visible @e1
stella-browser is enabled @e1
stella-browser is checked @e1
```

## Browser Settings

```bash
stella-browser set viewport 1920 1080
stella-browser set viewport 1920 1080 2
stella-browser set device "iPhone 12"
stella-browser set geo 37.7749 -122.4194
stella-browser set offline on
stella-browser set offline off
stella-browser set headers '{"X-Custom":"value"}'
stella-browser set credentials username password
stella-browser set media dark
stella-browser set media light reduced-motion
```

## Wait

```bash
stella-browser wait @e1
stella-browser wait 2000
stella-browser wait --text "Success"
stella-browser wait --url "**/dashboard"
stella-browser wait --fn "window.ready"
stella-browser wait --fn "!document.body.innerText.includes('Loading...')"
stella-browser wait --download ./file.pdf
stella-browser wait --download ./report.xlsx --timeout 30000
```

In extension-backed mode, use `wait <selector>`, `wait --text`, `wait --url`, `wait --fn`, or `wait <ms>`.

## Capture

```bash
stella-browser screenshot
stella-browser screenshot path.png
stella-browser screenshot @e1 ./element.png
stella-browser screenshot --full
stella-browser screenshot --annotate
stella-browser screenshot --screenshot-format jpeg --screenshot-quality 80
stella-browser pdf output.pdf
stella-browser download @e1 ./file.pdf
```

`--annotate` overlays numbered labels that correspond to snapshot refs and prints a legend.

## Cookies and Storage

```bash
stella-browser cookies
stella-browser cookies get --url https://app.example.com
stella-browser cookies set name value
stella-browser cookies set name value --url https://app.example.com
stella-browser cookies set name value --domain example.com --path / --secure --httpOnly
stella-browser cookies set name value --sameSite Strict
stella-browser cookies set name value --expires 1735689600
stella-browser cookies clear
stella-browser storage local
stella-browser storage local key
stella-browser storage local get key
stella-browser storage local set k v
stella-browser storage local clear
stella-browser storage session
stella-browser storage session get key
```

## Network

```bash
stella-browser network route <url>
stella-browser network route <url> --abort
stella-browser network route <url> --body '{}'
stella-browser network unroute [url]
stella-browser network requests
stella-browser network requests --filter api
stella-browser network requests --clear
```

Focused post-submit network check:

```bash
stella-browser network requests --clear
stella-browser click @e4
stella-browser wait --text "Saved"
stella-browser network requests --filter api --json
```

## Tabs

```bash
stella-browser tab                 # List tabs
stella-browser tab new [url]       # New tab
stella-browser tab 2               # Switch to tab by index
stella-browser tab close           # Close current tab
stella-browser tab close 2         # Close tab by index
stella-browser window new          # Open a new browser window
```

## Frames, Dialogs, Mouse, and Clipboard

```bash
stella-browser frame "#embed"
stella-browser frame main
stella-browser dialog accept
stella-browser dialog accept "prompt text"
stella-browser dialog dismiss
stella-browser mouse move 100 200
stella-browser mouse down left
stella-browser mouse up left
stella-browser mouse wheel 100
stella-browser clipboard read
stella-browser clipboard write "Hello"
stella-browser clipboard copy
stella-browser clipboard paste
```

## JavaScript

```bash
stella-browser eval "document.title"
stella-browser eval -b "<base64>"
stella-browser eval --stdin
```

Use `-b` or `--stdin` for complex scripts to avoid shell escaping issues.

## Diagnostics

```bash
stella-browser console
stella-browser console --clear
stella-browser errors
stella-browser errors --clear
stella-browser highlight @e1
```

Use `console`, `errors`, and `network requests` after submits or page transitions when the visible page state is ambiguous.

## Global Options

```bash
stella-browser --json ...              # JSON output for parsing
stella-browser --full ...              # Full page screenshot
stella-browser --annotate ...          # Numbered labels for screenshots
stella-browser --screenshot-dir <p> ...
stella-browser --screenshot-format png|jpeg ...
stella-browser --screenshot-quality 80 ...
stella-browser --download-path <p> ...
stella-browser --content-boundaries ...
stella-browser --max-output <chars> ...
stella-browser --help
stella-browser --version
stella-browser <command> --help
```
