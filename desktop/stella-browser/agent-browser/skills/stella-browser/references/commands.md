# Command Reference

Complete reference for all stella-browser commands. For quick start and common patterns, see SKILL.md.

## Navigation

```bash
stella-browser open <url>      # Navigate to URL (aliases: goto, navigate)
                              # Supports: https://, http://, file://, about:, data://
                              # Auto-prepends https:// if no protocol given
stella-browser back            # Go back
stella-browser forward         # Go forward
stella-browser reload          # Reload page
stella-browser close           # Close browser (aliases: quit, exit)
stella-browser connect 9222    # Connect to browser via CDP port
```

## Snapshot (page analysis)

```bash
stella-browser snapshot            # Full accessibility tree
stella-browser snapshot -i         # Interactive elements only (recommended)
stella-browser snapshot -c         # Compact output
stella-browser snapshot -d 3       # Limit depth to 3
stella-browser snapshot -s "#main" # Scope to CSS selector
```

## Interactions (use @refs from snapshot)

```bash
stella-browser click @e1           # Click
stella-browser dblclick @e1        # Double-click
stella-browser focus @e1           # Focus element
stella-browser fill @e2 "text"     # Clear and type
stella-browser type @e2 "text"     # Type without clearing
stella-browser press Enter         # Press key (alias: key)
stella-browser press Control+a     # Key combination
stella-browser keydown Shift       # Hold key down
stella-browser keyup Shift         # Release key
stella-browser hover @e1           # Hover
stella-browser check @e1           # Check checkbox
stella-browser uncheck @e1         # Uncheck checkbox
stella-browser select @e1 "value"  # Select dropdown option
stella-browser select @e1 "a" "b"  # Select multiple options
stella-browser scroll down 500     # Scroll page (default: down 300px)
stella-browser scrollintoview @e1  # Scroll element into view (alias: scrollinto)
stella-browser drag @e1 @e2        # Drag and drop
stella-browser upload @e1 file.pdf # Upload files
```

## Get Information

```bash
stella-browser get text @e1        # Get element text
stella-browser get html @e1        # Get innerHTML
stella-browser get value @e1       # Get input value
stella-browser get attr @e1 href   # Get attribute
stella-browser get title           # Get page title
stella-browser get url             # Get current URL
stella-browser get count ".item"   # Count matching elements
stella-browser get box @e1         # Get bounding box
stella-browser get styles @e1      # Get computed styles (font, color, bg, etc.)
```

## Check State

```bash
stella-browser is visible @e1      # Check if visible
stella-browser is enabled @e1      # Check if enabled
stella-browser is checked @e1      # Check if checked
```

## Screenshots and PDF

```bash
stella-browser screenshot          # Save to temporary directory
stella-browser screenshot path.png # Save to specific path
stella-browser screenshot --full   # Full page
stella-browser pdf output.pdf      # Save as PDF
```

## Video Recording

```bash
stella-browser record start ./demo.webm    # Start recording
stella-browser click @e1                   # Perform actions
stella-browser record stop                 # Stop and save video
stella-browser record restart ./take2.webm # Stop current + start new
```

## Wait

```bash
stella-browser wait @e1                     # Wait for element
stella-browser wait 2000                    # Wait milliseconds
stella-browser wait --text "Success"        # Wait for text (or -t)
stella-browser wait --url "**/dashboard"    # Wait for URL pattern (or -u)
stella-browser wait --load networkidle      # Wait for network idle (or -l)
stella-browser wait --fn "window.ready"     # Wait for JS condition (or -f)
```

## Mouse Control

```bash
stella-browser mouse move 100 200      # Move mouse
stella-browser mouse down left         # Press button
stella-browser mouse up left           # Release button
stella-browser mouse wheel 100         # Scroll wheel
```

## Semantic Locators (alternative to refs)

```bash
stella-browser find role button click --name "Submit"
stella-browser find text "Sign In" click
stella-browser find text "Sign In" click --exact      # Exact match only
stella-browser find label "Email" fill "user@test.com"
stella-browser find placeholder "Search" type "query"
stella-browser find alt "Logo" click
stella-browser find title "Close" click
stella-browser find testid "submit-btn" click
stella-browser find first ".item" click
stella-browser find last ".item" click
stella-browser find nth 2 "a" hover
```

## Browser Settings

```bash
stella-browser set viewport 1920 1080          # Set viewport size
stella-browser set device "iPhone 14"          # Emulate device
stella-browser set geo 37.7749 -122.4194       # Set geolocation (alias: geolocation)
stella-browser set offline on                  # Toggle offline mode
stella-browser set headers '{"X-Key":"v"}'     # Extra HTTP headers
stella-browser set credentials user pass       # HTTP basic auth (alias: auth)
stella-browser set media dark                  # Emulate color scheme
stella-browser set media light reduced-motion  # Light mode + reduced motion
```

## Cookies and Storage

```bash
stella-browser cookies                     # Get all cookies
stella-browser cookies set name value      # Set cookie
stella-browser cookies clear               # Clear cookies
stella-browser storage local               # Get all localStorage
stella-browser storage local key           # Get specific key
stella-browser storage local set k v       # Set value
stella-browser storage local clear         # Clear all
```

## Network

```bash
stella-browser network route <url>              # Intercept requests
stella-browser network route <url> --abort      # Block requests
stella-browser network route <url> --body '{}'  # Mock response
stella-browser network unroute [url]            # Remove routes
stella-browser network requests                 # View tracked requests
stella-browser network requests --filter api    # Filter requests
```

## Tabs and Windows

```bash
stella-browser tab                 # List tabs
stella-browser tab new [url]       # New tab
stella-browser tab 2               # Switch to tab by index
stella-browser tab close           # Close current tab
stella-browser tab close 2         # Close tab by index
stella-browser window new          # New window
```

## Frames

```bash
stella-browser frame "#iframe"     # Switch to iframe
stella-browser frame main          # Back to main frame
```

## Dialogs

```bash
stella-browser dialog accept [text]  # Accept dialog
stella-browser dialog dismiss        # Dismiss dialog
```

## JavaScript

```bash
stella-browser eval "document.title"          # Simple expressions only
stella-browser eval -b "<base64>"             # Any JavaScript (base64 encoded)
stella-browser eval --stdin                   # Read script from stdin
```

Use `-b`/`--base64` or `--stdin` for reliable execution. Shell escaping with nested quotes and special characters is error-prone.

```bash
# Base64 encode your script, then:
stella-browser eval -b "ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW3NyYyo9Il9uZXh0Il0nKQ=="

# Or use stdin with heredoc for multiline scripts:
cat <<'EOF' | stella-browser eval --stdin
const links = document.querySelectorAll('a');
Array.from(links).map(a => a.href);
EOF
```

## State Management

```bash
stella-browser state save auth.json    # Save cookies, storage, auth state
stella-browser state load auth.json    # Restore saved state
```

## Global Options

```bash
stella-browser --session <name> ...    # Isolated browser session
stella-browser --json ...              # JSON output for parsing
stella-browser --headed ...            # Show browser window (not headless)
stella-browser --full ...              # Full page screenshot (-f)
stella-browser --cdp <port> ...        # Connect via Chrome DevTools Protocol
stella-browser -p <provider> ...       # Cloud browser provider (--provider)
stella-browser --proxy <url> ...       # Use proxy server
stella-browser --headers <json> ...    # HTTP headers scoped to URL's origin
stella-browser --executable-path <p>   # Custom browser executable
stella-browser --extension <path> ...  # Load browser extension (repeatable)
stella-browser --ignore-https-errors   # Ignore SSL certificate errors
stella-browser --help                  # Show help (-h)
stella-browser --version               # Show version (-V)
stella-browser <command> --help        # Show detailed help for a command
```

## Debugging

```bash
stella-browser --headed open example.com   # Show browser window
stella-browser --cdp 9222 snapshot         # Connect via CDP port
stella-browser connect 9222                # Alternative: connect command
stella-browser console                     # View console messages
stella-browser console --clear             # Clear console
stella-browser errors                      # View page errors
stella-browser errors --clear              # Clear errors
stella-browser highlight @e1               # Highlight element
stella-browser trace start                 # Start recording trace
stella-browser trace stop trace.zip        # Stop and save trace
```

## Environment Variables

```bash
STELLA_BROWSER_SESSION="mysession"            # Default session name
STELLA_BROWSER_EXECUTABLE_PATH="/path/chrome" # Custom browser path
STELLA_BROWSER_EXTENSIONS="/ext1,/ext2"       # Comma-separated extension paths
STELLA_BROWSER_PROVIDER="browserbase"         # Cloud browser provider
STELLA_BROWSER_STREAM_PORT="9223"             # WebSocket streaming port
STELLA_BROWSER_HOME="/path/to/stella-browser"  # Custom install location
```
