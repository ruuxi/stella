# Command Reference

Supported `stella-browser` commands for Stella's extension-backed browser mode. For the normal workflow, see [stella-browser](life/knowledge/stella-browser.md).

Stella uses the user's real Chrome browser through the extension bridge. This reference intentionally omits standalone CLI surfaces such as proxy workflows, auth/state vaults, isolated sessions, provider switching, iOS/Appium, and direct CDP connection setup.

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
stella-browser scrollintoview @e1
stella-browser drag @e1 @e2
```

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

## Wait

```bash
stella-browser wait @e1
stella-browser wait 2000
stella-browser wait --text "Success"
stella-browser wait --url "**/dashboard"
stella-browser wait --fn "window.ready"
```

## Capture

```bash
stella-browser screenshot
stella-browser screenshot path.png
stella-browser screenshot --full
stella-browser pdf output.pdf
stella-browser download @e1 ./file.pdf
```

## Cookies and Storage

```bash
stella-browser cookies
stella-browser cookies set name value
stella-browser cookies clear
stella-browser storage local
stella-browser storage local key
stella-browser storage local set k v
stella-browser storage local clear
stella-browser storage session
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

## Tabs

```bash
stella-browser tab                 # List tabs
stella-browser tab new [url]       # New tab
stella-browser tab 2               # Switch to tab by index
stella-browser tab close           # Close current tab
stella-browser tab close 2         # Close tab by index
```

## Mouse and Clipboard

```bash
stella-browser mouse move 100 200
stella-browser mouse down left
stella-browser mouse up left
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

