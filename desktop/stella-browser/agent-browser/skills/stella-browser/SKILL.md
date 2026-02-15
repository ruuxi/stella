---
name: stella-browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.
allowed-tools: Bash(stella-browser:*)
---

# Browser Automation with stella-browser

## Core Workflow

Every browser automation follows this pattern:

1. **Navigate**: `stella-browser open <url>`
2. **Snapshot**: `stella-browser snapshot -i` (get element refs like `@e1`, `@e2`)
3. **Interact**: Use refs to click, fill, select
4. **Re-snapshot**: After navigation or DOM changes, get fresh refs

```bash
stella-browser open https://example.com/form
stella-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

stella-browser fill @e1 "user@example.com"
stella-browser fill @e2 "password123"
stella-browser click @e3
stella-browser wait --load networkidle
stella-browser snapshot -i  # Check result
```

## Essential Commands

```bash
# Navigation
stella-browser open <url>              # Navigate (aliases: goto, navigate)
stella-browser close                   # Close browser

# Snapshot
stella-browser snapshot -i             # Interactive elements with refs (recommended)
stella-browser snapshot -i -C          # Include cursor-interactive elements (divs with onclick, cursor:pointer)
stella-browser snapshot -s "#selector" # Scope to CSS selector

# Interaction (use @refs from snapshot)
stella-browser click @e1               # Click element
stella-browser fill @e2 "text"         # Clear and type text
stella-browser type @e2 "text"         # Type without clearing
stella-browser select @e1 "option"     # Select dropdown option
stella-browser check @e1               # Check checkbox
stella-browser press Enter             # Press key
stella-browser scroll down 500         # Scroll page

# Get information
stella-browser get text @e1            # Get element text
stella-browser get url                 # Get current URL
stella-browser get title               # Get page title

# Wait
stella-browser wait @e1                # Wait for element
stella-browser wait --load networkidle # Wait for network idle
stella-browser wait --url "**/page"    # Wait for URL pattern
stella-browser wait 2000               # Wait milliseconds

# Capture
stella-browser screenshot              # Screenshot to temp dir
stella-browser screenshot --full       # Full page screenshot
stella-browser pdf output.pdf          # Save as PDF
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

### Authentication with State Persistence

```bash
# Login once and save state
stella-browser open https://app.example.com/login
stella-browser snapshot -i
stella-browser fill @e1 "$USERNAME"
stella-browser fill @e2 "$PASSWORD"
stella-browser click @e3
stella-browser wait --url "**/dashboard"
stella-browser state save auth.json

# Reuse in future sessions
stella-browser state load auth.json
stella-browser open https://app.example.com/dashboard
```

### Data Extraction

```bash
stella-browser open https://example.com/products
stella-browser snapshot -i
stella-browser get text @e5           # Get specific element text
stella-browser get text body > page.txt  # Get all page text

# JSON output for parsing
stella-browser snapshot -i --json
stella-browser get text @e1 --json
```

### Parallel Sessions

```bash
stella-browser --session site1 open https://site-a.com
stella-browser --session site2 open https://site-b.com

stella-browser --session site1 snapshot -i
stella-browser --session site2 snapshot -i

stella-browser session list
```

### Visual Browser (Debugging)

```bash
stella-browser --headed open https://example.com
stella-browser highlight @e1          # Highlight element
stella-browser record start demo.webm # Record session
```

### Local Files (PDFs, HTML)

```bash
# Open local files with file:// URLs
stella-browser --allow-file-access open file:///path/to/document.pdf
stella-browser --allow-file-access open file:///path/to/page.html
stella-browser screenshot output.png
```

### iOS Simulator (Mobile Safari)

```bash
# List available iOS simulators
stella-browser device list

# Launch Safari on a specific device
stella-browser -p ios --device "iPhone 16 Pro" open https://example.com

# Same workflow as desktop - snapshot, interact, re-snapshot
stella-browser -p ios snapshot -i
stella-browser -p ios tap @e1          # Tap (alias for click)
stella-browser -p ios fill @e2 "text"
stella-browser -p ios swipe up         # Mobile-specific gesture

# Take screenshot
stella-browser -p ios screenshot mobile.png

# Close session (shuts down simulator)
stella-browser -p ios close
```

**Requirements:** macOS with Xcode, Appium (`npm install -g appium && appium driver install xcuitest`)

**Real devices:** Works with physical iOS devices if pre-configured. Use `--device "<UDID>"` where UDID is from `xcrun xctrace list devices`.

## Ref Lifecycle (Important)

Refs (`@e1`, `@e2`, etc.) are invalidated when the page changes. Always re-snapshot after:

- Clicking links or buttons that navigate
- Form submissions
- Dynamic content loading (dropdowns, modals)

```bash
stella-browser click @e5              # Navigates to new page
stella-browser snapshot -i            # MUST re-snapshot
stella-browser click @e1              # Use new refs
```

## Semantic Locators (Alternative to Refs)

When refs are unavailable or unreliable, use semantic locators:

```bash
stella-browser find text "Sign In" click
stella-browser find label "Email" fill "user@test.com"
stella-browser find role button click --name "Submit"
stella-browser find placeholder "Search" type "query"
stella-browser find testid "submit-btn" click
```

## Deep-Dive Documentation

| Reference | When to Use |
|-----------|-------------|
| [references/commands.md](references/commands.md) | Full command reference with all options |
| [references/snapshot-refs.md](references/snapshot-refs.md) | Ref lifecycle, invalidation rules, troubleshooting |
| [references/session-management.md](references/session-management.md) | Parallel sessions, state persistence, concurrent scraping |
| [references/authentication.md](references/authentication.md) | Login flows, OAuth, 2FA handling, state reuse |
| [references/video-recording.md](references/video-recording.md) | Recording workflows for debugging and documentation |
| [references/proxy-support.md](references/proxy-support.md) | Proxy configuration, geo-testing, rotating proxies |

## Ready-to-Use Templates

| Template | Description |
|----------|-------------|
| [templates/form-automation.sh](templates/form-automation.sh) | Form filling with validation |
| [templates/authenticated-session.sh](templates/authenticated-session.sh) | Login once, reuse state |
| [templates/capture-workflow.sh](templates/capture-workflow.sh) | Content extraction with screenshots |

```bash
./templates/form-automation.sh https://example.com/form
./templates/authenticated-session.sh https://app.example.com/login
./templates/capture-workflow.sh https://example.com ./output
```
