# Browser Automation (Optimized with Chain)

You control a real Chrome browser through a CLI. The daemon is already running.

## CLI Usage

Single commands use this prefix:
```bash
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" <command>
```

## Core Workflow

1. **Navigate**: `node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" open <url>`
2. **Observe (use chain)**: Batch multiple read operations into one chain command
3. **Interact**: Use refs from snapshot to click, fill, etc. (single commands)
4. **Re-observe (chain again)**: After DOM changes, chain snapshot + screenshot + text extraction

## Single Commands (for interactions)

```bash
# Navigation
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" open <url>

# Click, fill, type (must be individual)
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" click @e1
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" fill @e2 "text"

# Scroll
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" scroll down 500

# Wait
node "C:/Users/redacted/projects/agent-browser/bin/agent-browser.js" wait 2000
```

## Chain Command (for batching multiple observations)

When you need to run multiple read/observation commands (snapshot, get text, screenshot, boundingbox, etc.), batch them into a single chain command via TCP. This eliminates per-command CLI overhead (~220ms each).

Read the daemon port, then send a chain:

```bash
port=$(cat ~/.agent-browser/default.port)
node -e "
const net = require('net');
const s = net.connect($port, '127.0.0.1', () => {
  s.write(JSON.stringify({
    id: 'c1',
    action: 'chain',
    steps: [
      { action: 'snapshot', interactive: true, compact: true },
      { action: 'innertext', selector: 'h1' },
      { action: 'screenshot' }
    ],
    delay: { min: 0, max: 0 }
  }) + '\n');
});
let buf = '';
s.on('data', d => {
  buf += d.toString();
  if (buf.includes('\n')) {
    const res = JSON.parse(buf.split('\n')[0]);
    if (res.success) {
      for (const r of res.data.results) {
        if (r.action === 'snapshot' && r.data?.snapshot) console.log(r.data.snapshot);
        else if (r.action === 'innertext') console.log('TEXT:', r.data?.text);
        else if (r.action === 'screenshot') console.log('SCREENSHOT: (captured)');
      }
    } else {
      console.log('Chain failed:', JSON.stringify(res));
    }
    s.end();
    process.exit(0);
  }
});
setTimeout(() => process.exit(1), 15000);
"
```

### Chain step actions you can batch:
- `{ action: 'snapshot', interactive: true, compact: true }` — accessibility tree
- `{ action: 'innertext', selector: '<css>' }` — get text content
- `{ action: 'screenshot' }` — take screenshot
- `{ action: 'boundingbox', selector: '<css>' }` — element position
- `{ action: 'isvisible', selector: '<css>' }` — check visibility
- `{ action: 'navigate', url: '<url>' }` — navigate (as first step)

### When to use chain vs single commands:
- **Chain**: Any time you need 2+ observation/read commands in a row (snapshot + screenshot, snapshot + get text, etc.)
- **Single**: Interaction commands (click, fill, type, scroll) — these change state and should be individual

## Important Rules

- Refs (@e1, @e2) are invalidated after navigation or DOM changes. Always re-snapshot.
- Time every operation using: `start=$(date +%s%3N); <command>; end=$(date +%s%3N); echo "CMD: $((end-start))ms"`
- Keep a running total of all command times.
- Prefer chain for any consecutive observation steps.
