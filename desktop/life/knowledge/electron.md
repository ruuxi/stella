# Electron App Automation

Automate any Electron desktop app using stella-browser. Electron apps are built on Chromium and expose a Chrome DevTools Protocol (CDP) port that stella-browser can connect to, enabling the same snapshot-interact workflow used for web pages.

## Core Workflow

1. **Launch** the Electron app with remote debugging enabled
2. **Connect** stella-browser to the CDP port
3. **Snapshot** to discover interactive elements
4. **Interact** using element refs
5. **Re-snapshot** after navigation or state changes

```bash
# Launch an Electron app with remote debugging
# macOS
open -a "Slack" --args --remote-debugging-port=9222

# Windows
"$LOCALAPPDATA/slack/slack.exe" --remote-debugging-port=9222

# Linux
slack --remote-debugging-port=9222

# Connect stella-browser to the app
stella-browser connect 9222

# Standard workflow from here
stella-browser snapshot -i
stella-browser click @e5
stella-browser screenshot slack-desktop.png
```

## Launching Electron Apps with CDP

Every Electron app supports the `--remote-debugging-port` flag since it's built into Chromium.

### macOS

```bash
open -a "Slack" --args --remote-debugging-port=9222
open -a "Visual Studio Code" --args --remote-debugging-port=9223
open -a "Discord" --args --remote-debugging-port=9224
open -a "Figma" --args --remote-debugging-port=9225
open -a "Notion" --args --remote-debugging-port=9226
open -a "Spotify" --args --remote-debugging-port=9227
```

### Windows

```bash
"$LOCALAPPDATA/slack/slack.exe" --remote-debugging-port=9222
"$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" --remote-debugging-port=9223
"$LOCALAPPDATA/Discord/Update.exe" --processStart Discord.exe --process-start-args "--remote-debugging-port=9224"
```

### Linux

```bash
slack --remote-debugging-port=9222
code --remote-debugging-port=9223
discord --remote-debugging-port=9224
```

**Important:** If the app is already running, quit it first, then relaunch with the flag. The `--remote-debugging-port` flag must be present at launch time.

## Connecting

```bash
# Connect to a specific port
stella-browser connect 9222

# Or use --cdp on each command
stella-browser --cdp 9222 snapshot -i

# Auto-discover a running Chromium-based app
stella-browser --auto-connect snapshot -i
```

After `connect`, all subsequent commands target the connected app without needing `--cdp`.

## Tab Management

Electron apps often have multiple windows or webviews. Use tab commands to list and switch between them:

```bash
# List all available targets (windows, webviews, etc.)
stella-browser tab

# Switch to a specific tab by index
stella-browser tab 2

# Switch by URL pattern
stella-browser tab --url "*settings*"
```

## Common Patterns

### Inspect and Navigate an App

```bash
open -a "Slack" --args --remote-debugging-port=9222  # macOS
sleep 3  # Wait for app to start
stella-browser connect 9222
stella-browser snapshot -i
# Read the snapshot output to identify UI elements
stella-browser click @e10  # Navigate to a section
stella-browser snapshot -i  # Re-snapshot after navigation
```

### Take Screenshots of Desktop Apps

```bash
stella-browser connect 9222
stella-browser screenshot app-state.png
stella-browser screenshot --full full-app.png
stella-browser screenshot --annotate annotated-app.png
```

### Extract Data from a Desktop App

```bash
stella-browser connect 9222
stella-browser snapshot -i
stella-browser get text @e5
stella-browser snapshot --json > app-state.json
```

### Fill Forms in Desktop Apps

```bash
stella-browser connect 9222
stella-browser snapshot -i
stella-browser fill @e3 "search query"
stella-browser press Enter
stella-browser wait 1000
stella-browser snapshot -i
```

### Run Multiple Apps Simultaneously

Use named sessions to control multiple Electron apps at the same time:

```bash
# Connect to Slack
stella-browser --session slack connect 9222

# Connect to VS Code
stella-browser --session vscode connect 9223

# Interact with each independently
stella-browser --session slack snapshot -i
stella-browser --session vscode snapshot -i
```

## Color Scheme

Playwright overrides the color scheme to `light` by default when connecting via CDP. To preserve dark mode:

```bash
stella-browser connect 9222
stella-browser --color-scheme dark snapshot -i
```

Or set it globally:

```bash
AGENT_BROWSER_COLOR_SCHEME=dark stella-browser connect 9222
```

## Troubleshooting

### "Connection refused" or "Cannot connect"

- Make sure the app was launched with `--remote-debugging-port=NNNN`
- If the app was already running, quit and relaunch with the flag
- Check that the port isn't in use by another process

### App launches but connect fails

- Wait a few seconds after launch before connecting (`sleep 3`)
- Some apps take time to initialize their webview

### Elements not appearing in snapshot

- The app may use multiple webviews. Use `stella-browser tab` to list targets and switch to the right one
- Use `stella-browser snapshot -i -C` to include cursor-interactive elements (divs with onclick handlers)

### Cannot type in input fields

- Try `stella-browser keyboard type "text"` to type at the current focus without a selector
- Some Electron apps use custom input components; use `stella-browser keyboard inserttext "text"` to bypass key events

## Supported Apps

Any app built on Electron works, including:

- **Communication:** Slack, Discord, Microsoft Teams, Signal, Telegram Desktop
- **Development:** VS Code, GitHub Desktop, Postman, Insomnia
- **Design:** Figma, Notion, Obsidian
- **Media:** Spotify, Tidal
- **Productivity:** Todoist, Linear, 1Password

If an app is built with Electron, it supports `--remote-debugging-port` and can be automated with stella-browser.