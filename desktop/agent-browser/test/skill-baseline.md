# Browser Automation (Baseline)

You control a real Chrome browser through a CLI. The daemon is already running.

## CLI Usage

Every command uses this prefix:
```bash
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" <command>
```

## Core Workflow

1. **Navigate**: `node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" open <url>`
2. **Snapshot**: `node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" snapshot -ic` (get interactive element refs like @e1, @e2)
3. **Interact**: Use refs from snapshot to click, fill, etc.
4. **Re-snapshot**: After any navigation or DOM change, get fresh refs

## Commands

```bash
# Navigation
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" open <url>

# Snapshot (always use -ic for interactive+compact)
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" snapshot -ic

# Click, fill, type
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" click @e1
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" fill @e2 "text"

# Get info
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" get text @e1
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" get text body
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" get url
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" get title

# Screenshot
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" screenshot

# Scroll
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" scroll down 500

# Wait
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" wait 2000
```

## Important Rules

- Refs (@e1, @e2) are invalidated after navigation or DOM changes. Always re-snapshot.
- Time every command using: `start=$(date +%s%3N); <command>; end=$(date +%s%3N); echo "CMD: $((end-start))ms"`
- Keep a running total of all command times.
