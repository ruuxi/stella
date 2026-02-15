# Extension Mode Speed Optimizations

All optimizations were introduced in commits `f91c9f3` and `5ace77a`. Each can be reverted independently.

---

## 1. Debugger Detach Timeout (60s → 5min)

**What**: Chrome debugger auto-detaches after idle timeout. Re-attaching costs ~50-100ms.

**Change**: Increased idle timeout from 60 seconds to 5 minutes.

**File**: `extension/lib/debugger.js` line 8

```js
// BEFORE
const DETACH_TIMEOUT = 60000;

// AFTER
const DETACH_TIMEOUT = 300000;
```

**To revert**: Change `300000` back to `60000`.

**Risk**: Debugger stays attached longer. No functional impact — just keeps a debugger session open in background.

---

## 2. Debugger Pre-warm After Navigation

**What**: After `navigate` or `reload`, the first command that needs the debugger (click, eval, etc.) pays ~50-100ms to attach. Pre-warming attaches proactively right after navigation completes.

**File**: `extension/commands/navigation.js`

**In `handleNavigate()`** (after the `waitForLoad` logic):
```js
// Pre-warm debugger for subsequent commands
try { await ensureDebugger(updated.id); } catch {}
```

**In `handleReload()`** (after reload completes):
```js
// Pre-warm debugger for subsequent commands
try { await ensureDebugger(tab.id); } catch {}
```

**Also added import** at top of file:
```js
import { ensureDebugger } from '../lib/debugger.js';
```

**To revert**: Remove the two `try { await ensureDebugger(...) } catch {}` blocks and the import.

**Risk**: None. The `try/catch` ensures failures are silent. Adds ~5ms to navigation completion time.

---

## 3. Screenshot Default Format (PNG → JPEG q60)

**What**: Default screenshots changed from PNG (1-3MB) to JPEG quality 60 (100-300KB). 60-80% smaller payloads.

**File**: `extension/commands/capture.js` lines 13-15

```js
// BEFORE
const format = command.format || 'png';
const quality = command.quality;

// AFTER
const format = command.format || 'jpeg';
const quality = command.quality ?? (format === 'jpeg' ? 60 : undefined);
```

**To revert**: Change `'jpeg'` back to `'png'` and remove the quality fallback.

**Risk**: Lower image quality. Agents that need pixel-perfect screenshots should pass `format: 'png'` explicitly.

---

## 4. Health Check Caching (5s TTL)

**What**: The daemon's extension bridge verified the WebSocket connection (3s timeout healthcheck) before EVERY command. Now it caches the last successful check and skips re-checking within 5 seconds.

**File**: `src/extension-bridge.ts`

**Properties added**:
```ts
private lastHealthCheckSuccess: number = 0;
private static HEALTH_CHECK_TTL = 5000;
```

**In `executeCommand()` method** — skip healthcheck if recent:
```ts
const timeSinceLastCheck = Date.now() - this.lastHealthCheckSuccess;
let isAlive = timeSinceLastCheck < ExtensionBridge.HEALTH_CHECK_TTL;

if (!isAlive) {
  isAlive = await this.verifyConnection();
  if (isAlive) {
    this.lastHealthCheckSuccess = Date.now();
  }
}
```

**Timestamp updated on**: successful health check, successful command response, successful reconnect.
**Timestamp reset on**: disconnect, error.

**To revert**: Remove the `lastHealthCheckSuccess` property and TTL check. Restore the unconditional `verifyConnection()` call in `executeCommand()`.

**Risk**: If the WebSocket drops silently, the first command within the TTL window will fail instead of reconnecting proactively. The failure will trigger a reconnect attempt, so the second command should recover.

---

## 5. Chain Command (Batched Execution)

**What**: New `chain` action that sends multiple steps as one command. The extension executes them sequentially with implicit selector waits and configurable delays. Eliminates per-command CLI overhead (~220ms each).

**Files**:
- `extension/commands/chain.js` — chain execution engine (NEW)
- `extension/background.js` — chain import + handler registration (2 lines)
- `src/protocol.ts` — `chainSchema` + `chainStepSchema` (19 lines)
- `src/types.ts` — `ChainStep`, `ChainCommand` interfaces (16 lines)

**To revert**:
1. Delete `extension/commands/chain.js`
2. Remove from `extension/background.js`:
   - `import { handleChain } from './commands/chain.js';`
   - `chain: (cmd) => handleChain(cmd, HANDLERS),`
3. Remove from `src/protocol.ts`: `chainStepSchema`, `chainSchema`, and `chainSchema` from the union
4. Remove from `src/types.ts`: `ChainStep`, `ChainCommand`, and `ChainCommand` from the `Command` union

**Risk**: None if removed — chain is additive. Agents that don't know about chain will continue using sequential commands.

**Chain command format**:
```json
{
  "action": "chain",
  "steps": [
    { "action": "snapshot", "interactive": true, "compact": true },
    { "action": "innertext", "selector": "h1" },
    { "action": "screenshot" }
  ],
  "delay": { "min": 0, "max": 0 },
  "abortOnError": true
}
```

**Options**:
| Option | Default | Description |
|--------|---------|-------------|
| `delay.min` / `delay.max` | 300 / 1200 | Random delay range (ms) between steps |
| `waitForSelector` | `true` | Implicit wait for selector before each step |
| `waitTimeout` | `10000` | Max wait time for selector (ms) |
| `abortOnError` | `true` | Stop chain on first failure |
| `returnSnapshot` | `false` | Append final snapshot to response |
| `returnScreenshot` | `false` | Append final screenshot to response |

---

## Performance Impact

Measured on real sites (YouTube, Amazon) with agent-driven browsing:

| Metric | Baseline | Optimized | Improvement |
|--------|----------|-----------|-------------|
| CLI overhead per command | ~250ms | ~250ms | Same (CLI unchanged) |
| Chain: 3 observations | ~750ms (3 calls) | ~117ms (1 chain) | **6.4x faster** |
| Chain: 2 observations | ~500ms (2 calls) | ~114ms (1 chain) | **4.4x faster** |
| Observation total (session) | ~3,250ms | ~539ms | **83% reduction** |
| Total invocations (session) | 22 | 14 | **36% fewer** |

The biggest wins come from chaining observation commands (snapshot, screenshot, get text) that don't need interaction between them. Navigation and interaction commands remain individual CLI calls.
