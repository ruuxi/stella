// `execFileSync`/`spawn`: Node process primitives, e.g. `spawn("bun", ["run", "worker.js"])`.
import { execFileSync, spawn } from "node:child_process";
// `delay`: promise-based sleep helper, e.g. `await delay(250)`.
import { setTimeout as delay } from "node:timers/promises";

// `isWindows`: boolean, e.g. `true` on Windows and `false` on macOS/Linux.
const isWindows = process.platform === "win32";
// `noop`: empty function, e.g. `() => undefined`.
const noop = () => undefined;

// `waitForExit`: `(child) => Promise<void>`, e.g. resolves after pid `14320` exits.
const waitForExit = (child) => new Promise((resolve) => child?.exitCode !== null || child?.signalCode !== null ? resolve() : child?.once("exit", () => resolve()));

// `killTree`: `(child, options?) => Promise<void>`, e.g. kills one process plus its descendants.
const killTree = async (child, { graceSignal = "SIGTERM", forceAfterMs = 1_500 } = {}) => {
  // `child?.pid`: number | undefined, e.g. `14320`.
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  // `isWindows`: boolean, e.g. `true` when `taskkill /T /F` is required.
  if (isWindows) {
    // `Promise<void>`: waits for the tree-kill helper to finish.
    await new Promise((resolve) => {
      // `killer`: ChildProcess, e.g. `taskkill /pid 14320 /T /F`.
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      // `error`: Error, e.g. `spawn taskkill ENOENT`.
      killer.once("error", () => { try { child.kill(graceSignal); } catch {} resolve(); });
      // `code`: number | null, e.g. `0`.
      killer.once("exit", () => resolve());
    });
    // `undefined`: return after the Windows process-tree path completes.
    return;
  }
  // `child.pid`: number, e.g. `14320`.
  try { process.kill(-child.pid, graceSignal); } catch { try { child.kill(graceSignal); } catch {} }
  // `Promise<void>`: waits for graceful exit or escalates after the timeout.
  await Promise.race([waitForExit(child), delay(forceAfterMs).then(() => { try { child.kill("SIGKILL"); } catch {} })]).catch(() => undefined);
  // `Promise<void>`: ensures the process is fully gone before returning.
  await waitForExit(child).catch(() => undefined);
};

// `stopHandle`: `(handle) => Promise<void>`, e.g. stops either a raw child or a custom sidecar handle.
const stopHandle = async (handle) => {
  // `handle`: object | null, e.g. `{ child, stop }` or `{ stop }`.
  if (!handle) return;
  // `handle.stop`: function | undefined, e.g. a custom graceful shutdown hook.
  if (typeof handle.stop === "function") { await Promise.resolve(handle.stop()).catch(() => undefined); return; }
  // `handle.child`: ChildProcess | undefined, e.g. a spawned daemon process.
  if (handle.child) await killTree(handle.child).catch(() => undefined);
};

// `createRendererCrashHandler`: `(deps?) => (details) => void`, e.g. keeps app alive and loads a recovery page.
const createRendererCrashHandler = ({ markUnavailable = noop, loadRecoveryPage = noop } = {}) => {
  // `details`: object, e.g. `{ reason: "crashed", exitCode: 139 }`.
  return (details) => {
    // `details?.reason`: string | undefined, e.g. `"crashed"`.
    markUnavailable(details?.reason ?? "renderer unavailable");
    // `undefined`: intentionally does recovery work instead of global shutdown.
    loadRecoveryPage();
  };
};

// `createRetryingSidecar`: `(options) => sidecar`, e.g. browser bridge or Cloudflare tunnel manager.
const createRetryingSidecar = ({ name, launch, beforeStart = noop, onState = noop, shutdown = noop, required = false, baseDelayMs = 1_000, maxDelayMs = 30_000 } = {}) => {
  // `handle`: object | null, e.g. `{ child, stop }`.
  let handle = null;
  // `launchPromise`: Promise<object | void> | null, e.g. in-flight daemon start.
  let launchPromise = null;
  // `retryTimer`: Timeout | null, e.g. scheduled reconnect timer.
  let retryTimer = null;
  // `attempt`: number, e.g. `0` on first try or `4` after repeated failures.
  let attempt = 0;
  // `stopped`: boolean, e.g. `false` while the sidecar should stay alive.
  let stopped = true;

  // `clearRetry`: `() => void`, e.g. cancels a pending reconnect timer.
  const clearRetry = () => { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; };

  // `wireHandle`: `(nextHandle) => nextHandle`, e.g. attaches child exit/error to restart behavior.
  const wireHandle = (nextHandle) => {
    // `child`: ChildProcess | undefined, e.g. the daemon owned by this sidecar.
    const child = nextHandle?.child;
    // `nextHandle`: object, e.g. unchanged custom handle.
    if (!child) return nextHandle;
    // `code`/`signal`: number | null / NodeJS.Signals | null, e.g. `1` or `"SIGTERM"`.
    child.once("exit", (code, signal) => { if (handle !== nextHandle || stopped) return; handle = null; required ? void shutdown(`${name} exited ${signal ? `via ${signal}` : `with code ${code ?? 0}`}`) : scheduleRestart(signal ? `${name} exited via ${signal}` : `${name} exited with code ${code ?? 0}`); });
    // `error`: Error, e.g. startup pipe failure.
    child.once("error", (error) => { if (handle !== nextHandle || stopped) return; handle = null; required ? void shutdown(`${name} failed: ${error.message}`) : scheduleRestart(`${name} failed: ${error.message}`); });
    // `nextHandle`: object, e.g. the now-wired child handle.
    return nextHandle;
  };

  // `scheduleRestart`: `(reason) => void`, e.g. retries with exponential backoff.
  const scheduleRestart = (reason) => {
    // `stopped`: boolean, e.g. skip retries during app shutdown.
    if (stopped) return;
    // `attempt`: number, e.g. increments from `0` to `1`.
    attempt += 1;
    // `nextRetryMs`: number, e.g. `1000`, `2000`, `4000`.
    const nextRetryMs = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
    // `status`: object, e.g. `{ name: "bridge", state: "reconnecting", attempt: 2 }`.
    onState({ name, state: "reconnecting", attempt, nextRetryMs, error: reason });
    // `retryTimer`: Timeout | null, e.g. previous reconnect timer to replace.
    clearRetry();
    // `retryTimer`: Timeout, e.g. a `setTimeout` handle that restarts the sidecar.
    retryTimer = setTimeout(() => { retryTimer = null; void start("reconnecting"); }, nextRetryMs);
  };

  // `start`: `(phase?) => Promise<object | void>`, e.g. `"connecting"` or `"reconnecting"`.
  const start = (phase = "connecting") => {
    // `launchPromise`: Promise<object | void> | null, e.g. dedupes concurrent start calls.
    if (launchPromise) return launchPromise;
    // `Promise<object | void>`: sidecar boot sequence.
    launchPromise = (async () => {
      // `stopped`: boolean, e.g. `true` only before first start or after explicit stop.
      if (stopped) stopped = false;
      // `status`: object, e.g. `{ state: "connecting", attempt: 0 }`.
      onState({ name, state: phase, attempt });
      // `Promise<void>`: service-specific cleanup before binding a fresh session or port.
      await Promise.resolve(beforeStart()).catch(() => undefined);
      try {
        // `nextHandle`: object | void, e.g. `{ child }` or `{ stop }`.
        const nextHandle = await launch({ name, attempt, scheduleRestart, isStopping: () => stopped });
        // `handle`: object | null, e.g. the current active sidecar handle.
        handle = wireHandle(nextHandle ?? null);
        // `attempt`: number, e.g. reset to `0` once healthy.
        attempt = 0;
        // `status`: object, e.g. `{ state: "connected", attempt: 0 }`.
        onState({ name, state: "connected", attempt: 0 });
        // `handle`: object | null, e.g. returned for callers that need introspection.
        return handle;
      } catch (error) {
        // `message`: string, e.g. `"ECONNREFUSED"` or `"token missing"`.
        const message = error instanceof Error ? error.message : String(error);
        // `handle`: object | null, e.g. cleared before retry logic.
        handle = null;
        // `required`: boolean, e.g. `true` for fatal sidecars or `false` for recoverable ones.
        required ? await shutdown(`${name} failed to start: ${message}`) : scheduleRestart(`${name} failed to start: ${message}`);
        // `undefined`: failure path intentionally returns no handle.
        return undefined;
      } finally {
        // `launchPromise`: Promise<object | void> | null, e.g. clear in-flight boot marker.
        launchPromise = null;
      }
    })();
    // `launchPromise`: Promise<object | void>, e.g. current deduped start request.
    return launchPromise;
  };

  // `stop`: `() => Promise<void>`, e.g. disables retries and tears down the active handle.
  const stop = async () => {
    // `stopped`: boolean, e.g. `true` after explicit stop or app shutdown.
    stopped = true;
    // `retryTimer`: Timeout | null, e.g. cleared so reconnects cannot re-arm.
    clearRetry();
    // `handle`: object | null, e.g. current child-backed sidecar.
    const active = handle;
    // `handle`: object | null, e.g. clear visible state before awaiting stop.
    handle = null;
    // `Promise<void>`: service-specific stop path.
    await stopHandle(active);
    // `status`: object, e.g. `{ state: "stopped" }`.
    onState({ name, state: "stopped", attempt: 0 });
  };

  // `snapshot`: `() => object`, e.g. current sidecar state for logging or tests.
  const snapshot = () => ({ name, running: Boolean(handle), starting: Boolean(launchPromise), attempt, stopped });

  // `sidecar`: object, e.g. `{ start, stop, snapshot }`.
  return { start, stop, snapshot };
};

// `createIdleWorker`: `(options) => worker`, e.g. lazy worker with graceful drain + idle shutdown.
const createIdleWorker = ({ name, launch, shutdown = noop, onState = noop, isPinned = async () => false, idleTimeoutMs = 5 * 60_000, drainTimeoutMs = 1_500, eager = false } = {}) => {
  // `handle`: object | null, e.g. `{ child, stop }`.
  let handle = null;
  // `startPromise`: Promise<object | null> | null, e.g. deduped worker start.
  let startPromise = null;
  // `stopPromise`: Promise<void> | null, e.g. in-flight graceful stop.
  let stopPromise = null;
  // `idleTimer`: Timeout | null, e.g. re-check timer for worker idling.
  let idleTimer = null;
  // `inFlight`: number, e.g. `2` active RPC calls waiting to finish.
  let inFlight = 0;
  // `lastActivityAt`: number, e.g. `Date.now()` in milliseconds.
  let lastActivityAt = 0;
  // `state`: string, e.g. `"idle"`, `"starting"`, `"running"`, or `"stopping"`.
  let state = "idle";

  // `clearIdleTimer`: `() => void`, e.g. cancels the current idle evaluation timer.
  const clearIdleTimer = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };

  // `noteActivity`: `() => void`, e.g. marks a request or start event as recent work.
  const noteActivity = () => { lastActivityAt = Date.now(); };

  // `waitForDrain`: `() => Promise<void>`, e.g. allows in-flight work to finish before forced stop.
  const waitForDrain = async () => { const deadline = Date.now() + drainTimeoutMs; while (inFlight > 0 && Date.now() < deadline) await delay(25); };

  // `scheduleIdleCheck`: `(delayMs?) => void`, e.g. re-arms the idle timer after each request.
  const scheduleIdleCheck = (delayMs = idleTimeoutMs) => {
    // `state`: string, e.g. only running workers should be idled.
    if (state !== "running" || !handle) return;
    // `idleTimer`: Timeout | null, e.g. replace any earlier scheduled check.
    clearIdleTimer();
    // `idleTimer`: Timeout, e.g. timer that eventually calls `evaluateIdle`.
    idleTimer = setTimeout(() => { idleTimer = null; void evaluateIdle(); }, delayMs);
  };

  // `ensureStarted`: `() => Promise<object | null>`, e.g. lazily launches the worker on first request.
  const ensureStarted = () => {
    // `handle`: object | null, e.g. already-running worker connection.
    if (handle) return Promise.resolve(handle);
    // `startPromise`: Promise<object | null> | null, e.g. existing in-flight start.
    if (startPromise) return startPromise;
    // `state`: string, e.g. `"starting"` during launch.
    state = "starting";
    // `status`: object, e.g. `{ state: "starting" }`.
    onState({ name, state });
    // `Promise<object | null>`: worker launch sequence.
    startPromise = (async () => {
      try {
        // `nextHandle`: object, e.g. `{ child }`.
        const nextHandle = await launch({ name });
        // `handle`: object | null, e.g. the active worker handle.
        handle = nextHandle ?? null;
        // `state`: string, e.g. `"running"` after a healthy start.
        state = "running";
        // `lastActivityAt`: number, e.g. start time used for idle eviction.
        noteActivity();
        // `status`: object, e.g. `{ state: "running" }`.
        onState({ name, state });
        // `child`: ChildProcess | undefined, e.g. background runtime worker.
        handle?.child?.once("exit", () => { if (handle !== nextHandle) return; handle = null; clearIdleTimer(); state = "idle"; onState({ name, state, reason: "worker exited" }); });
        // `child`: ChildProcess | undefined, e.g. launch pipe failure after start.
        handle?.child?.once("error", (error) => { if (handle !== nextHandle) return; handle = null; clearIdleTimer(); state = "idle"; onState({ name, state, reason: error.message }); });
        // `idleTimer`: Timeout | null, e.g. arm idle shutdown after the worker comes online.
        scheduleIdleCheck();
        // `handle`: object | null, e.g. caller-facing worker handle.
        return handle;
      } catch (error) {
        // `message`: string, e.g. `"bun not found"` or `"initialize failed"`.
        const message = error instanceof Error ? error.message : String(error);
        // `handle`: object | null, e.g. failed start leaves no active worker.
        handle = null;
        // `state`: string, e.g. `"idle"` after failed startup.
        state = "idle";
        // `status`: object, e.g. `{ state: "idle", reason: "launch failed" }`.
        onState({ name, state, reason: message });
        // `Promise<void>`: lets the parent runtime decide if start failures are fatal.
        await shutdown(`${name} failed to start: ${message}`);
        // `undefined`: failure path intentionally returns no handle.
        return null;
      } finally {
        // `startPromise`: Promise<object | null> | null, e.g. clear launch dedupe marker.
        startPromise = null;
      }
    })();
    // `startPromise`: Promise<object | null>, e.g. current launch request.
    return startPromise;
  };

  // `stop`: `(reason?) => Promise<void>`, e.g. `"idle"` or `"runtime shutdown"`.
  const stop = async (reason = "stopped") => {
    // `stopPromise`: Promise<void> | null, e.g. reuse an in-flight stop if one exists.
    if (stopPromise) return stopPromise;
    // `active`: object | null, e.g. the worker being stopped.
    const active = handle;
    // `handle`: object | null, e.g. clear public state up front.
    handle = null;
    // `idleTimer`: Timeout | null, e.g. stop future idle checks.
    clearIdleTimer();
    // `state`: string, e.g. `"stopping"` while the graceful stop runs.
    state = "stopping";
    // `status`: object, e.g. `{ state: "stopping", reason: "runtime shutdown" }`.
    onState({ name, state, reason });
    // `Promise<void>`: stop sequence that drains in-flight work before kill.
    stopPromise = (async () => {
      // `reason`: string, e.g. non-idle stops wait for in-flight requests.
      if (reason !== "idle") await waitForDrain();
      // `Promise<void>`: custom worker stop or raw child tree kill.
      await stopHandle(active);
      // `state`: string, e.g. `"idle"` once the worker is fully gone.
      state = "idle";
      // `status`: object, e.g. `{ state: "idle", reason: "runtime shutdown" }`.
      onState({ name, state, reason });
    })().finally(() => { stopPromise = null; });
    // `stopPromise`: Promise<void>, e.g. returned so callers can await shutdown completion.
    return stopPromise;
  };

  // `evaluateIdle`: `() => Promise<void>`, e.g. auto-stops the worker when nothing is using it.
  const evaluateIdle = async () => {
    // `state`: string, e.g. only running workers should be evaluated for idling.
    if (state !== "running" || !handle) return;
    // `inFlight`: number, e.g. requests still using the worker.
    if (inFlight > 0) return void scheduleIdleCheck(30_000);
    // `idleForMs`: number, e.g. `42000`.
    const idleForMs = Date.now() - lastActivityAt;
    // `idleTimeoutMs`: number, e.g. `300000`.
    if (idleForMs < idleTimeoutMs) return void scheduleIdleCheck(idleTimeoutMs - idleForMs);
    // `pinned`: boolean, e.g. `true` if voice, social, or another subsystem should keep the worker alive.
    const pinned = await Promise.resolve(isPinned()).catch(() => false);
    // `pinned`: boolean, e.g. re-check later if the worker is still needed.
    if (pinned) return void scheduleIdleCheck(30_000);
    // `Promise<void>`: idle shutdown mirrors the production worker idle path.
    await stop("idle");
  };

  // `request`: `(run) => Promise<any>`, e.g. wraps one RPC or task execution against the worker.
  const request = async (run) => {
    // `active`: object | null, e.g. worker handle available for the request body.
    const active = await ensureStarted();
    // `active`: object | null, e.g. startup can fail and return `null`.
    if (!active) throw new Error(`${name} is not available.`);
    // `inFlight`: number, e.g. increment from `0` to `1`.
    inFlight += 1;
    // `lastActivityAt`: number, e.g. mark this request as recent work.
    noteActivity();
    try {
      // `run(active)`: Promise<any>, e.g. one JSON-RPC request or command.
      return await run(active);
    } finally {
      // `inFlight`: number, e.g. decrement back toward `0`.
      inFlight = Math.max(0, inFlight - 1);
      // `lastActivityAt`: number, e.g. track completion time for idle windows.
      noteActivity();
      // `idleTimer`: Timeout | null, e.g. restart idle countdown after each request.
      scheduleIdleCheck();
    }
  };

  // `start`: `() => Promise<object | null>`, e.g. eager boot path that mirrors production startup.
  const start = () => ensureStarted();

  // `snapshot`: `() => object`, e.g. current worker lifecycle state for logging or tests.
  const snapshot = () => ({ name, state, running: Boolean(handle), inFlight, lastActivityAt });

  // `eager`: boolean, e.g. `true` if the worker should start immediately.
  if (eager) void start();

  // `worker`: object, e.g. `{ start, stop, request, snapshot }`.
  return { start, stop, request, snapshot };
};

// `createProcessRuntime`: `(options?) => runtime`, e.g. one-file app orchestration for children and sidecars.
const createProcessRuntime = ({ onShutdown = noop } = {}) => {
  // `stoppers`: Map<string, (reason?: string) => Promise<void> | void>, e.g. all managed cleanup callbacks.
  const stoppers = new Map();
  // `stopping`: boolean, e.g. `false` until the first shutdown starts.
  let stopping = false;

  // `addStopper`: `(name, stop) => stop`, e.g. registers a cleanup callback by stable key.
  const addStopper = (name, stop) => (stoppers.set(name, stop), stop);

  // `removeStopper`: `(name) => void`, e.g. unregisters already-exited children.
  const removeStopper = (name) => { stoppers.delete(name); };

  // `shutdown`: `(reason?) => Promise<void>`, e.g. central app cleanup entrypoint.
  const shutdown = async (reason = "manual shutdown") => {
    // `stopping`: boolean guard, e.g. avoids duplicate work from SIGINT + before-quit.
    if (stopping) return;
    // `stopping`: boolean, e.g. now `true` for all later checks.
    stopping = true;
    // `reason`: string, e.g. `"[runtime] electron before-quit"`.
    console.log(`[runtime] ${reason}`);
    // `entries`: Array<[string, Function]>, e.g. reverse order for a stack-like shutdown.
    const entries = [...stoppers.entries()].reverse();
    // `entries`: array, e.g. each registered child, sidecar, or worker cleanup hook.
    for (const [, stop] of entries) await Promise.resolve(stop(reason)).catch(() => undefined);
    // `reason`: string, e.g. forwarded to outer cleanup work like auth loops or shortcuts.
    await Promise.resolve(onShutdown(reason)).catch(() => undefined);
  };

  // `attachSignals`: `() => runtime`, e.g. captures Ctrl+C or external SIGTERM.
  const attachSignals = () => {
    // `signal`: string, e.g. `"SIGINT"` or `"SIGTERM"`.
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void shutdown(`received ${signal}`); });
    // `runtime`: object, e.g. fluent API return.
    return runtime;
  };

  // `attachElectronApp`: `(app, deps?) => runtime`, e.g. wires `before-quit` and `will-quit`.
  const attachElectronApp = (app, { onWillQuit = noop } = {}) => {
    // `app`: Electron.App-like object, e.g. real `app` from `electron`.
    app.on("before-quit", () => { void shutdown("electron before-quit"); });
    // `app`: Electron.App-like object, e.g. hook for shortcut unregisters and final teardown.
    app.on("will-quit", () => { void Promise.resolve(onWillQuit()).catch(() => undefined); });
    // `runtime`: object, e.g. fluent API return.
    return runtime;
  };

  // `startChild`: `(options) => entry`, e.g. dev-runner managed processes like Vite or Electron.
  const startChild = ({ name, command, args = [], cwd = process.cwd(), env = process.env, stdio = "inherit", required = true, detached = !isWindows } = {}) => {
    // `child`: ChildProcess, e.g. spawned `vite`, `electron`, or `bun run worker`.
    const child = spawn(command, args, { cwd, env, stdio, detached, windowsHide: true });
    // `stop`: `() => Promise<void>`, e.g. app-wide shutdown cleanup for this child tree.
    const stop = async () => { removeStopper(name); await killTree(child).catch(() => undefined); };
    // `stoppers`: map entry, e.g. `"vite" -> stop`.
    addStopper(name, stop);
    // `error`: Error, e.g. process spawn failure.
    child.once("error", (error) => { removeStopper(name); if (!stopping && required) void shutdown(`${name} failed to start: ${error.message}`); });
    // `code`/`signal`: number | null / NodeJS.Signals | null, e.g. child exit details.
    child.once("exit", (code, signal) => { removeStopper(name); if (!stopping && required) void shutdown(`${name} exited ${signal ? `via ${signal}` : `with code ${code ?? 0}`}`); });
    // `entry`: object, e.g. caller-facing child record with a direct `stop()`.
    return { name, child, stop };
  };

  // `startSidecar`: `(options) => sidecar`, e.g. browser bridge or Cloudflare tunnel.
  const startSidecar = (options = {}) => {
    // `sidecar`: object, e.g. retrying sidecar controller.
    const sidecar = createRetryingSidecar({ ...options, shutdown });
    // `stoppers`: map entry, e.g. `"cloudflareTunnel" -> sidecar.stop`.
    addStopper(options.name, () => sidecar.stop());
    // `Promise<object | void>`: start the recoverable sidecar immediately.
    void sidecar.start();
    // `sidecar`: object, e.g. caller-facing controller.
    return sidecar;
  };

  // `startWorker`: `(options) => worker`, e.g. lazy runtime worker with idle shutdown.
  const startWorker = (options = {}) => {
    // `worker`: object, e.g. worker lifecycle controller.
    const worker = createIdleWorker({ ...options, shutdown });
    // `stoppers`: map entry, e.g. `"runtimeWorker" -> worker.stop`.
    addStopper(options.name, () => worker.stop("runtime shutdown"));
    // `worker`: object, e.g. caller-facing worker controller.
    return worker;
  };

  // `listManaged`: `() => string[]`, e.g. `["vite", "electron-main", "browserBridge"]`.
  const listManaged = () => [...stoppers.keys()];

  // `runtime`: object, e.g. full one-file orchestration API.
  const runtime = { attachSignals, attachElectronApp, startChild, startSidecar, startWorker, shutdown, listManaged, isStopping: () => stopping };

  // `runtime`: object, e.g. return value used by callers.
  return runtime;
};

// `runDemo`: `() => Promise<void>`, e.g. runnable example for this one-file extraction.
const runDemo = async () => {
  // `rendererCrashHandler`: function, e.g. handles renderer failure without app shutdown.
  const rendererCrashHandler = createRendererCrashHandler({ markUnavailable: (reason) => console.log(`[renderer] unavailable: ${reason}`), loadRecoveryPage: () => console.log("[renderer] load recovery page") });
  // `runtime`: object, e.g. one-file process manager instance.
  const runtime = createProcessRuntime({ onShutdown: (reason) => console.log(`[runtime] outer cleanup: ${reason}`) }).attachSignals();
  // `tunnelAlive`: boolean, e.g. fake Cloudflare tunnel service state.
  let tunnelAlive = false;
  // `bridgeRuns`: number, e.g. counts recoverable bridge launches.
  let bridgeRuns = 0;

  // `childEntry`: object, e.g. fake Vite dev server managed as a required child.
  const childEntry = runtime.startChild({ name: "vite", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], stdio: "ignore" });
  // `childEntry.child.pid`: number | undefined, e.g. fake dev-server pid.
  console.log(`[demo] vite pid: ${childEntry.child.pid ?? "missing"}`);

  // `tunnel`: object, e.g. recoverable non-child sidecar like Cloudflare.
  const tunnel = runtime.startSidecar({ name: "cloudflareTunnel", launch: async () => { tunnelAlive = true; return { stop: () => { tunnelAlive = false; console.log("[sidecar] cloudflare tunnel stopped"); } }; }, onState: (status) => console.log(`[sidecar] ${status.name} -> ${status.state}`) });
  // `tunnel.snapshot()`: object, e.g. `{ running: true, starting: false }`.
  console.log(`[demo] tunnel snapshot: ${JSON.stringify(tunnel.snapshot())}`);

  // `bridge`: object, e.g. retrying child-backed sidecar like the browser bridge daemon.
  const bridge = runtime.startSidecar({ name: "browserBridge", launch: async () => { bridgeRuns += 1; return { child: spawn(process.execPath, ["-e", bridgeRuns === 1 ? "setTimeout(() => process.exit(1), 50)" : "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true }) }; }, onState: (status) => console.log(`[sidecar] ${status.name} -> ${status.state}${status.error ? ` (${status.error})` : ""}`), baseDelayMs: 100, maxDelayMs: 200 });
  // `bridge.snapshot()`: object, e.g. current bridge launch state.
  console.log(`[demo] bridge snapshot: ${JSON.stringify(bridge.snapshot())}`);

  // `worker`: object, e.g. lazy runtime worker that idles itself when unused.
  const worker = runtime.startWorker({ name: "runtimeWorker", idleTimeoutMs: 200, eager: true, launch: async () => ({ child: spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true }) }), onState: (status) => console.log(`[worker] ${status.name} -> ${status.state}${status.reason ? ` (${status.reason})` : ""}`) });
  // `worker.request(...)`: Promise<string>, e.g. one fake RPC round-trip.
  const result = await worker.request(async () => { await delay(50); return "ok"; });
  // `result`: string, e.g. `"ok"`.
  console.log(`[demo] worker request result: ${result}`);

  // `rendererCrashHandler(...)`: undefined, e.g. keeps recovery separate from shutdown.
  rendererCrashHandler({ reason: "crashed" });
  // `Promise<void>`: wait for the bridge to crash once and reconnect.
  await delay(350);
  // `Promise<void>`: wait for the worker idle timer to stop the now-unused worker.
  await delay(300);
  // `worker.snapshot()`: object, e.g. should now show `state: "idle"`.
  console.log(`[demo] worker snapshot after idle: ${JSON.stringify(worker.snapshot())}`);
  // `runtime.listManaged()`: string[], e.g. currently registered cleanup hooks.
  console.log(`[demo] managed entries: ${JSON.stringify(runtime.listManaged())}`);
  // `Promise<void>`: central shutdown path for child + sidecars + worker.
  await runtime.shutdown("demo finished");
  // `tunnelAlive`: boolean, e.g. should now be `false`.
  console.log(`[demo] tunnel alive after shutdown: ${tunnelAlive}`);
};

// `process.argv.includes("--demo")`: boolean, e.g. `true` for `node process-cleanup-minimal.mjs --demo`.
if (process.argv.includes("--demo")) await runDemo();

// `createProcessRuntime`: exported factory, e.g. import into another scratch file.
export { createProcessRuntime };
// `createRetryingSidecar`: exported helper, e.g. build one recoverable daemon in isolation.
export { createRetryingSidecar };
// `createIdleWorker`: exported helper, e.g. wrap a lazy runtime worker.
export { createIdleWorker };
// `createRendererCrashHandler`: exported helper, e.g. keep renderer recovery separate from app shutdown.
export { createRendererCrashHandler };
// `killTree`: exported helper, e.g. one-off cross-platform process-tree cleanup.
export { killTree };
