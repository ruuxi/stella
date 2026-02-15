# stella-browser

Headless browser automation CLI for AI agents. Fast Rust CLI with Node.js fallback.

## Installation

### npm (recommended)

```bash
npm install -g stella-browser
stella-browser install  # Download Chromium
```

### Homebrew (macOS)

```bash
brew install stella-browser
stella-browser install  # Download Chromium
```

### From Source

```bash
git clone https://github.com/vercel-labs/stella-browser
cd stella-browser
pnpm install
pnpm build
pnpm build:native   # Requires Rust (https://rustup.rs)
pnpm link --global  # Makes stella-browser available globally
stella-browser install
```

### Linux Dependencies

On Linux, install system dependencies:

```bash
stella-browser install --with-deps
# or manually: npx playwright install-deps chromium
```

## Quick Start

```bash
stella-browser open example.com
stella-browser snapshot                    # Get accessibility tree with refs
stella-browser click @e2                   # Click by ref from snapshot
stella-browser fill @e3 "test@example.com" # Fill by ref
stella-browser get text @e1                # Get text by ref
stella-browser screenshot page.png
stella-browser close
```

### Traditional Selectors (also supported)

```bash
stella-browser click "#submit"
stella-browser fill "#email" "test@example.com"
stella-browser find role button click --name "Submit"
```

## Commands

### Core Commands

```bash
stella-browser open <url>              # Navigate to URL (aliases: goto, navigate)
stella-browser click <sel>             # Click element
stella-browser dblclick <sel>          # Double-click element
stella-browser focus <sel>             # Focus element
stella-browser type <sel> <text>       # Type into element
stella-browser fill <sel> <text>       # Clear and fill
stella-browser press <key>             # Press key (Enter, Tab, Control+a) (alias: key)
stella-browser keydown <key>           # Hold key down
stella-browser keyup <key>             # Release key
stella-browser hover <sel>             # Hover element
stella-browser select <sel> <val>      # Select dropdown option
stella-browser check <sel>             # Check checkbox
stella-browser uncheck <sel>           # Uncheck checkbox
stella-browser scroll <dir> [px]       # Scroll (up/down/left/right)
stella-browser scrollintoview <sel>    # Scroll element into view (alias: scrollinto)
stella-browser drag <src> <tgt>        # Drag and drop
stella-browser upload <sel> <files>    # Upload files
stella-browser screenshot [path]       # Take screenshot (--full for full page, saves to a temporary directory if no path)
stella-browser pdf <path>              # Save as PDF
stella-browser snapshot                # Accessibility tree with refs (best for AI)
stella-browser eval <js>               # Run JavaScript (-b for base64, --stdin for piped input)
stella-browser connect <port>          # Connect to browser via CDP
stella-browser close                   # Close browser (aliases: quit, exit)
```

### Get Info

```bash
stella-browser get text <sel>          # Get text content
stella-browser get html <sel>          # Get innerHTML
stella-browser get value <sel>         # Get input value
stella-browser get attr <sel> <attr>   # Get attribute
stella-browser get title               # Get page title
stella-browser get url                 # Get current URL
stella-browser get count <sel>         # Count matching elements
stella-browser get box <sel>           # Get bounding box
```

### Check State

```bash
stella-browser is visible <sel>        # Check if visible
stella-browser is enabled <sel>        # Check if enabled
stella-browser is checked <sel>        # Check if checked
```

### Find Elements (Semantic Locators)

```bash
stella-browser find role <role> <action> [value]       # By ARIA role
stella-browser find text <text> <action>               # By text content
stella-browser find label <label> <action> [value]     # By label
stella-browser find placeholder <ph> <action> [value]  # By placeholder
stella-browser find alt <text> <action>                # By alt text
stella-browser find title <text> <action>              # By title attr
stella-browser find testid <id> <action> [value]       # By data-testid
stella-browser find first <sel> <action> [value]       # First match
stella-browser find last <sel> <action> [value]        # Last match
stella-browser find nth <n> <sel> <action> [value]     # Nth match
```

**Actions:** `click`, `fill`, `check`, `hover`, `text`

**Examples:**
```bash
stella-browser find role button click --name "Submit"
stella-browser find text "Sign In" click
stella-browser find label "Email" fill "test@test.com"
stella-browser find first ".item" click
stella-browser find nth 2 "a" text
```

### Wait

```bash
stella-browser wait <selector>         # Wait for element to be visible
stella-browser wait <ms>               # Wait for time (milliseconds)
stella-browser wait --text "Welcome"   # Wait for text to appear
stella-browser wait --url "**/dash"    # Wait for URL pattern
stella-browser wait --load networkidle # Wait for load state
stella-browser wait --fn "window.ready === true"  # Wait for JS condition
```

**Load states:** `load`, `domcontentloaded`, `networkidle`

### Mouse Control

```bash
stella-browser mouse move <x> <y>      # Move mouse
stella-browser mouse down [button]     # Press button (left/right/middle)
stella-browser mouse up [button]       # Release button
stella-browser mouse wheel <dy> [dx]   # Scroll wheel
```

### Browser Settings

```bash
stella-browser set viewport <w> <h>    # Set viewport size
stella-browser set device <name>       # Emulate device ("iPhone 14")
stella-browser set geo <lat> <lng>     # Set geolocation
stella-browser set offline [on|off]    # Toggle offline mode
stella-browser set headers <json>      # Extra HTTP headers
stella-browser set credentials <u> <p> # HTTP basic auth
stella-browser set media [dark|light]  # Emulate color scheme
```

### Cookies & Storage

```bash
stella-browser cookies                 # Get all cookies
stella-browser cookies set <name> <val> # Set cookie
stella-browser cookies clear           # Clear cookies

stella-browser storage local           # Get all localStorage
stella-browser storage local <key>     # Get specific key
stella-browser storage local set <k> <v>  # Set value
stella-browser storage local clear     # Clear all

stella-browser storage session         # Same for sessionStorage
```

### Network

```bash
stella-browser network route <url>              # Intercept requests
stella-browser network route <url> --abort      # Block requests
stella-browser network route <url> --body <json>  # Mock response
stella-browser network unroute [url]            # Remove routes
stella-browser network requests                 # View tracked requests
stella-browser network requests --filter api    # Filter requests
```

### Tabs & Windows

```bash
stella-browser tab                     # List tabs
stella-browser tab new [url]           # New tab (optionally with URL)
stella-browser tab <n>                 # Switch to tab n
stella-browser tab close [n]           # Close tab
stella-browser window new              # New window
```

### Frames

```bash
stella-browser frame <sel>             # Switch to iframe
stella-browser frame main              # Back to main frame
```

### Dialogs

```bash
stella-browser dialog accept [text]    # Accept (with optional prompt text)
stella-browser dialog dismiss          # Dismiss
```

### Debug

```bash
stella-browser trace start [path]      # Start recording trace
stella-browser trace stop [path]       # Stop and save trace
stella-browser console                 # View console messages (log, error, warn, info)
stella-browser console --clear         # Clear console
stella-browser errors                  # View page errors (uncaught JavaScript exceptions)
stella-browser errors --clear          # Clear errors
stella-browser highlight <sel>         # Highlight element
stella-browser state save <path>       # Save auth state
stella-browser state load <path>       # Load auth state
```

### Navigation

```bash
stella-browser back                    # Go back
stella-browser forward                 # Go forward
stella-browser reload                  # Reload page
```

### Setup

```bash
stella-browser install                 # Download Chromium browser
stella-browser install --with-deps     # Also install system deps (Linux)
```

## Sessions

Run multiple isolated browser instances:

```bash
# Different sessions
stella-browser --session agent1 open site-a.com
stella-browser --session agent2 open site-b.com

# Or via environment variable
STELLA_BROWSER_SESSION=agent1 stella-browser click "#btn"

# List active sessions
stella-browser session list
# Output:
# Active sessions:
# -> default
#    agent1

# Show current session
stella-browser session
```

Each session has its own:
- Browser instance
- Cookies and storage
- Navigation history
- Authentication state

## Persistent Profiles

By default, browser state (cookies, localStorage, login sessions) is ephemeral and lost when the browser closes. Use `--profile` to persist state across browser restarts:

```bash
# Use a persistent profile directory
stella-browser --profile ~/.myapp-profile open myapp.com

# Login once, then reuse the authenticated session
stella-browser --profile ~/.myapp-profile open myapp.com/dashboard

# Or via environment variable
STELLA_BROWSER_PROFILE=~/.myapp-profile stella-browser open myapp.com
```

The profile directory stores:
- Cookies and localStorage
- IndexedDB data
- Service workers
- Browser cache
- Login sessions

**Tip**: Use different profile paths for different projects to keep their browser state isolated.

## Snapshot Options

The `snapshot` command supports filtering to reduce output size:

```bash
stella-browser snapshot                    # Full accessibility tree
stella-browser snapshot -i                 # Interactive elements only (buttons, inputs, links)
stella-browser snapshot -i -C              # Include cursor-interactive elements (divs with onclick, etc.)
stella-browser snapshot -c                 # Compact (remove empty structural elements)
stella-browser snapshot -d 3               # Limit depth to 3 levels
stella-browser snapshot -s "#main"         # Scope to CSS selector
stella-browser snapshot -i -c -d 5         # Combine options
```

| Option | Description |
|--------|-------------|
| `-i, --interactive` | Only show interactive elements (buttons, links, inputs) |
| `-C, --cursor` | Include cursor-interactive elements (cursor:pointer, onclick, tabindex) |
| `-c, --compact` | Remove empty structural elements |
| `-d, --depth <n>` | Limit tree depth |
| `-s, --selector <sel>` | Scope to CSS selector |

The `-C` flag is useful for modern web apps that use custom clickable elements (divs, spans) instead of standard buttons/links.

## Options

| Option | Description |
|--------|-------------|
| `--session <name>` | Use isolated session (or `STELLA_BROWSER_SESSION` env) |
| `--profile <path>` | Persistent browser profile directory (or `STELLA_BROWSER_PROFILE` env) |
| `--headers <json>` | Set HTTP headers scoped to the URL's origin |
| `--executable-path <path>` | Custom browser executable (or `STELLA_BROWSER_EXECUTABLE_PATH` env) |
| `--args <args>` | Browser launch args, comma or newline separated (or `STELLA_BROWSER_ARGS` env) |
| `--user-agent <ua>` | Custom User-Agent string (or `STELLA_BROWSER_USER_AGENT` env) |
| `--proxy <url>` | Proxy server URL with optional auth (or `STELLA_BROWSER_PROXY` env) |
| `--proxy-bypass <hosts>` | Hosts to bypass proxy (or `STELLA_BROWSER_PROXY_BYPASS` env) |
| `-p, --provider <name>` | Cloud browser provider (or `STELLA_BROWSER_PROVIDER` env) |
| `--json` | JSON output (for agents) |
| `--full, -f` | Full page screenshot |
| `--name, -n` | Locator name filter |
| `--exact` | Exact text match |
| `--headed` | Show browser window (not headless) |
| `--cdp <port>` | Connect via Chrome DevTools Protocol |
| `--ignore-https-errors` | Ignore HTTPS certificate errors (useful for self-signed certs) |
| `--allow-file-access` | Allow file:// URLs to access local files (Chromium only) |
| `--debug` | Debug output |

## Selectors

### Refs (Recommended for AI)

Refs provide deterministic element selection from snapshots:

```bash
# 1. Get snapshot with refs
stella-browser snapshot
# Output:
# - heading "Example Domain" [ref=e1] [level=1]
# - button "Submit" [ref=e2]
# - textbox "Email" [ref=e3]
# - link "Learn more" [ref=e4]

# 2. Use refs to interact
stella-browser click @e2                   # Click the button
stella-browser fill @e3 "test@example.com" # Fill the textbox
stella-browser get text @e1                # Get heading text
stella-browser hover @e4                   # Hover the link
```

**Why use refs?**
- **Deterministic**: Ref points to exact element from snapshot
- **Fast**: No DOM re-query needed
- **AI-friendly**: Snapshot + ref workflow is optimal for LLMs

### CSS Selectors

```bash
stella-browser click "#id"
stella-browser click ".class"
stella-browser click "div > button"
```

### Text & XPath

```bash
stella-browser click "text=Submit"
stella-browser click "xpath=//button"
```

### Semantic Locators

```bash
stella-browser find role button click --name "Submit"
stella-browser find label "Email" fill "test@test.com"
```

## Agent Mode

Use `--json` for machine-readable output:

```bash
stella-browser snapshot --json
# Returns: {"success":true,"data":{"snapshot":"...","refs":{"e1":{"role":"heading","name":"Title"},...}}}

stella-browser get text @e1 --json
stella-browser is visible @e2 --json
```

### Optimal AI Workflow

```bash
# 1. Navigate and get snapshot
stella-browser open example.com
stella-browser snapshot -i --json   # AI parses tree and refs

# 2. AI identifies target refs from snapshot
# 3. Execute actions using refs
stella-browser click @e2
stella-browser fill @e3 "input text"

# 4. Get new snapshot if page changed
stella-browser snapshot -i --json
```

## Headed Mode

Show the browser window for debugging:

```bash
stella-browser open example.com --headed
```

This opens a visible browser window instead of running headless.

## Authenticated Sessions

Use `--headers` to set HTTP headers for a specific origin, enabling authentication without login flows:

```bash
# Headers are scoped to api.example.com only
stella-browser open api.example.com --headers '{"Authorization": "Bearer <token>"}'

# Requests to api.example.com include the auth header
stella-browser snapshot -i --json
stella-browser click @e2

# Navigate to another domain - headers are NOT sent (safe!)
stella-browser open other-site.com
```

This is useful for:
- **Skipping login flows** - Authenticate via headers instead of UI
- **Switching users** - Start new sessions with different auth tokens
- **API testing** - Access protected endpoints directly
- **Security** - Headers are scoped to the origin, not leaked to other domains

To set headers for multiple origins, use `--headers` with each `open` command:

```bash
stella-browser open api.example.com --headers '{"Authorization": "Bearer token1"}'
stella-browser open api.acme.com --headers '{"Authorization": "Bearer token2"}'
```

For global headers (all domains), use `set headers`:

```bash
stella-browser set headers '{"X-Custom-Header": "value"}'
```

## Custom Browser Executable

Use a custom browser executable instead of the bundled Chromium. This is useful for:
- **Serverless deployment**: Use lightweight Chromium builds like `@sparticuz/chromium` (~50MB vs ~684MB)
- **System browsers**: Use an existing Chrome/Chromium installation
- **Custom builds**: Use modified browser builds

### CLI Usage

```bash
# Via flag
stella-browser --executable-path /path/to/chromium open example.com

# Via environment variable
STELLA_BROWSER_EXECUTABLE_PATH=/path/to/chromium stella-browser open example.com
```

### Serverless Example (Vercel/AWS Lambda)

```typescript
import chromium from '@sparticuz/chromium';
import { BrowserManager } from 'stella-browser';

export async function handler() {
  const browser = new BrowserManager();
  await browser.launch({
    executablePath: await chromium.executablePath(),
    headless: true,
  });
  // ... use browser
}
```

## Local Files

Open and interact with local files (PDFs, HTML, etc.) using `file://` URLs:

```bash
# Enable file access (required for JavaScript to access local files)
stella-browser --allow-file-access open file:///path/to/document.pdf
stella-browser --allow-file-access open file:///path/to/page.html

# Take screenshot of a local PDF
stella-browser --allow-file-access open file:///Users/me/report.pdf
stella-browser screenshot report.png
```

The `--allow-file-access` flag adds Chromium flags (`--allow-file-access-from-files`, `--allow-file-access`) that allow `file://` URLs to:
- Load and render local files
- Access other local files via JavaScript (XHR, fetch)
- Load local resources (images, scripts, stylesheets)

**Note:** This flag only works with Chromium. For security, it's disabled by default.

## CDP Mode

Connect to an existing browser via Chrome DevTools Protocol:

```bash
# Start Chrome with: google-chrome --remote-debugging-port=9222

# Connect once, then run commands without --cdp
stella-browser connect 9222
stella-browser snapshot
stella-browser tab
stella-browser close

# Or pass --cdp on each command
stella-browser --cdp 9222 snapshot

# Connect to remote browser via WebSocket URL
stella-browser --cdp "wss://your-browser-service.com/cdp?token=..." snapshot
```

The `--cdp` flag accepts either:
- A port number (e.g., `9222`) for local connections via `http://localhost:{port}`
- A full WebSocket URL (e.g., `wss://...` or `ws://...`) for remote browser services

This enables control of:
- Electron apps
- Chrome/Chromium instances with remote debugging
- WebView2 applications
- Any browser exposing a CDP endpoint

## Streaming (Browser Preview)

Stream the browser viewport via WebSocket for live preview or "pair browsing" where a human can watch and interact alongside an AI agent.

### Enable Streaming

Set the `STELLA_BROWSER_STREAM_PORT` environment variable:

```bash
STELLA_BROWSER_STREAM_PORT=9223 stella-browser open example.com
```

This starts a WebSocket server on the specified port that streams the browser viewport and accepts input events.

### WebSocket Protocol

Connect to `ws://localhost:9223` to receive frames and send input:

**Receive frames:**
```json
{
  "type": "frame",
  "data": "<base64-encoded-jpeg>",
  "metadata": {
    "deviceWidth": 1280,
    "deviceHeight": 720,
    "pageScaleFactor": 1,
    "offsetTop": 0,
    "scrollOffsetX": 0,
    "scrollOffsetY": 0
  }
}
```

**Send mouse events:**
```json
{
  "type": "input_mouse",
  "eventType": "mousePressed",
  "x": 100,
  "y": 200,
  "button": "left",
  "clickCount": 1
}
```

**Send keyboard events:**
```json
{
  "type": "input_keyboard",
  "eventType": "keyDown",
  "key": "Enter",
  "code": "Enter"
}
```

**Send touch events:**
```json
{
  "type": "input_touch",
  "eventType": "touchStart",
  "touchPoints": [{ "x": 100, "y": 200 }]
}
```

### Programmatic API

For advanced use, control streaming directly via the protocol:

```typescript
import { BrowserManager } from 'stella-browser';

const browser = new BrowserManager();
await browser.launch({ headless: true });
await browser.navigate('https://example.com');

// Start screencast
await browser.startScreencast((frame) => {
  // frame.data is base64-encoded image
  // frame.metadata contains viewport info
  console.log('Frame received:', frame.metadata.deviceWidth, 'x', frame.metadata.deviceHeight);
}, {
  format: 'jpeg',
  quality: 80,
  maxWidth: 1280,
  maxHeight: 720,
});

// Inject mouse events
await browser.injectMouseEvent({
  type: 'mousePressed',
  x: 100,
  y: 200,
  button: 'left',
});

// Inject keyboard events
await browser.injectKeyboardEvent({
  type: 'keyDown',
  key: 'Enter',
  code: 'Enter',
});

// Stop when done
await browser.stopScreencast();
```

## Architecture

stella-browser uses a client-daemon architecture:

1. **Rust CLI** (fast native binary) - Parses commands, communicates with daemon
2. **Node.js Daemon** - Manages Playwright browser instance
3. **Fallback** - If native binary unavailable, uses Node.js directly

The daemon starts automatically on first command and persists between commands for fast subsequent operations.

**Browser Engine:** Uses Chromium by default. The daemon also supports Firefox and WebKit via the Playwright protocol.

## Platforms

| Platform | Binary | Fallback |
|----------|--------|----------|
| macOS ARM64 | Native Rust | Node.js |
| macOS x64 | Native Rust | Node.js |
| Linux ARM64 | Native Rust | Node.js |
| Linux x64 | Native Rust | Node.js |
| Windows x64 | Native Rust | Node.js |

## Usage with AI Agents

### Just ask the agent

The simplest approach - just tell your agent to use it:

```
Use stella-browser to test the login flow. Run stella-browser --help to see available commands.
```

The `--help` output is comprehensive and most agents can figure it out from there.

### AI Coding Assistants

Add the skill to your AI coding assistant for richer context:

```bash
npx skills add vercel-labs/stella-browser
```

This works with Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, Goose, OpenCode, and Windsurf.

### AGENTS.md / CLAUDE.md

For more consistent results, add to your project or global instructions file:

```markdown
## Browser Automation

Use `stella-browser` for web automation. Run `stella-browser --help` for all commands.

Core workflow:
1. `stella-browser open <url>` - Navigate to page
2. `stella-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `stella-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
```

## Integrations

### iOS Simulator

Control real Mobile Safari in the iOS Simulator for authentic mobile web testing. Requires macOS with Xcode.

**Setup:**

```bash
# Install Appium and XCUITest driver
npm install -g appium
appium driver install xcuitest
```

**Usage:**

```bash
# List available iOS simulators
stella-browser device list

# Launch Safari on a specific device
stella-browser -p ios --device "iPhone 16 Pro" open https://example.com

# Same commands as desktop
stella-browser -p ios snapshot -i
stella-browser -p ios tap @e1
stella-browser -p ios fill @e2 "text"
stella-browser -p ios screenshot mobile.png

# Mobile-specific commands
stella-browser -p ios swipe up
stella-browser -p ios swipe down 500

# Close session
stella-browser -p ios close
```

Or use environment variables:

```bash
export STELLA_BROWSER_PROVIDER=ios
export STELLA_BROWSER_IOS_DEVICE="iPhone 16 Pro"
stella-browser open https://example.com
```

| Variable | Description |
|----------|-------------|
| `STELLA_BROWSER_PROVIDER` | Set to `ios` to enable iOS mode |
| `STELLA_BROWSER_IOS_DEVICE` | Device name (e.g., "iPhone 16 Pro", "iPad Pro") |
| `STELLA_BROWSER_IOS_UDID` | Device UDID (alternative to device name) |

**Supported devices:** All iOS Simulators available in Xcode (iPhones, iPads), plus real iOS devices.

**Note:** The iOS provider boots the simulator, starts Appium, and controls Safari. First launch takes ~30-60 seconds; subsequent commands are fast.

#### Real Device Support

Appium also supports real iOS devices connected via USB. This requires additional one-time setup:

**1. Get your device UDID:**
```bash
xcrun xctrace list devices
# or
system_profiler SPUSBDataType | grep -A 5 "iPhone\|iPad"
```

**2. Sign WebDriverAgent (one-time):**
```bash
# Open the WebDriverAgent Xcode project
cd ~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent
open WebDriverAgent.xcodeproj
```

In Xcode:
- Select the `WebDriverAgentRunner` target
- Go to Signing & Capabilities
- Select your Team (requires Apple Developer account, free tier works)
- Let Xcode manage signing automatically

**3. Use with stella-browser:**
```bash
# Connect device via USB, then:
stella-browser -p ios --device "<DEVICE_UDID>" open https://example.com

# Or use the device name if unique
stella-browser -p ios --device "John's iPhone" open https://example.com
```

**Real device notes:**
- First run installs WebDriverAgent to the device (may require Trust prompt)
- Device must be unlocked and connected via USB
- Slightly slower initial connection than simulator
- Tests against real Safari performance and behavior

### Browserbase

[Browserbase](https://browserbase.com) provides remote browser infrastructure to make deployment of agentic browsing agents easy. Use it when running the stella-browser CLI in an environment where a local browser isn't feasible.

To enable Browserbase, use the `-p` flag:

```bash
export BROWSERBASE_API_KEY="your-api-key"
export BROWSERBASE_PROJECT_ID="your-project-id"
stella-browser -p browserbase open https://example.com
```

Or use environment variables for CI/scripts:

```bash
export STELLA_BROWSER_PROVIDER=browserbase
export BROWSERBASE_API_KEY="your-api-key"
export BROWSERBASE_PROJECT_ID="your-project-id"
stella-browser open https://example.com
```

When enabled, stella-browser connects to a Browserbase session instead of launching a local browser. All commands work identically.

Get your API key and project ID from the [Browserbase Dashboard](https://browserbase.com/overview).

### Browser Use

[Browser Use](https://browser-use.com) provides cloud browser infrastructure for AI agents. Use it when running stella-browser in environments where a local browser isn't available (serverless, CI/CD, etc.).

To enable Browser Use, use the `-p` flag:

```bash
export BROWSER_USE_API_KEY="your-api-key"
stella-browser -p browseruse open https://example.com
```

Or use environment variables for CI/scripts:

```bash
export STELLA_BROWSER_PROVIDER=browseruse
export BROWSER_USE_API_KEY="your-api-key"
stella-browser open https://example.com
```

When enabled, stella-browser connects to a Browser Use cloud session instead of launching a local browser. All commands work identically.

Get your API key from the [Browser Use Cloud Dashboard](https://cloud.browser-use.com/settings?tab=api-keys). Free credits are available to get started, with pay-as-you-go pricing after.

### Kernel

[Kernel](https://www.kernel.sh) provides cloud browser infrastructure for AI agents with features like stealth mode and persistent profiles.

To enable Kernel, use the `-p` flag:

```bash
export KERNEL_API_KEY="your-api-key"
stella-browser -p kernel open https://example.com
```

Or use environment variables for CI/scripts:

```bash
export STELLA_BROWSER_PROVIDER=kernel
export KERNEL_API_KEY="your-api-key"
stella-browser open https://example.com
```

Optional configuration via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `KERNEL_HEADLESS` | Run browser in headless mode (`true`/`false`) | `false` |
| `KERNEL_STEALTH` | Enable stealth mode to avoid bot detection (`true`/`false`) | `true` |
| `KERNEL_TIMEOUT_SECONDS` | Session timeout in seconds | `300` |
| `KERNEL_PROFILE_NAME` | Browser profile name for persistent cookies/logins (created if it doesn't exist) | (none) |

When enabled, stella-browser connects to a Kernel cloud session instead of launching a local browser. All commands work identically.

**Profile Persistence:** When `KERNEL_PROFILE_NAME` is set, the profile will be created if it doesn't already exist. Cookies, logins, and session data are automatically saved back to the profile when the browser session ends, making them available for future sessions.

Get your API key from the [Kernel Dashboard](https://dashboard.onkernel.com).

## License

Apache-2.0
