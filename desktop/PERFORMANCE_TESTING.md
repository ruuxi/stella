# Stella UI Performance Testing

This is the target shape for a full Stella desktop performance and re-render
test harness. It is intentionally broader than a small smoke pass: the harness
should drive real desktop UI flows, capture Chrome DevTools Protocol traces, and
record React Profiler commits from the same run so regressions can be tied to
the actual component tree.

## Goals

- Exercise the full renderer shell in Electron, not isolated component stories.
- Capture Chrome trace, CPU profile, long-task, heap, screenshot, and React
  Profiler evidence for each scenario.
- Fail on explicit budgets for commit count, commit duration, long tasks,
  layout shifts, main-thread time, and memory growth.
- Keep every run reproducible from the repo root with checked-in scenarios,
  checked-in budgets, and timestamped artifacts under `state/outputs/perf/`.
- Preserve Stella's real runtime contracts while allowing deterministic test
  fixtures for chat streams, activity, recent files, model catalogs, store data,
  onboarding state, and display tabs.

## Launch Model

The harness should launch the existing Electron dev app with an added CDP port
instead of creating a separate browser-only test app.

1. Build preload and Electron bundles using the same paths as
   `bun run electron:dev`.
2. Start Vite with `NODE_ENV=development` and wait for `desktop/.vite-dev-url`.
3. Start Electron with `--remote-debugging-port=0` or a deterministic free port.
4. Discover the renderer target via `http://127.0.0.1:<port>/json/list`.
5. Attach Playwright over CDP for input, accessibility snapshots, screenshots,
   tracing, CPU profiling, heap sampling, and performance marks.
6. Use the existing preload IPC surface where appropriate. The current
   `window.electronAPI.system.recordHeapTrace(durationMs)` path already records
   an Electron `contentTracing` memory trace through
   `desktop/electron/ipc/system-handlers.ts`.

The launch code should live under `desktop/tests/perf/runner/` and use
repo-root dependencies. Do not install Playwright or helpers inside `desktop/`.

## React Profiler Instrumentation

Add a dev/test-only profiler layer around major renderer regions. The layer
should be inert unless `window.__STELLA_PERF__` or `STELLA_PERF=1` is enabled.

Recommended implementation:

- Add `desktop/src/perf/ProfilerBoundary.tsx`.
- Wrap top-level regions in `ProfilerBoundary` with stable ids.
- Send each `onRender` event to an in-memory collector on
  `window.__STELLA_PERF__`.
- Expose a small renderer API:
  - `startScenario(name, metadata)`
  - `mark(label)`
  - `stopScenario()`
  - `getReactProfile()`
  - `reset()`

Initial profiler ids:

- `app.root`
- `shell.full`
- `shell.topbar`
- `shell.sidebar`
- `chat.full`
- `chat.sidebar`
- `chat.timeline`
- `chat.composer`
- `display.sidebar`
- `display.tabstrip`
- `settings.models`
- `model.picker`
- `store.route`
- `store.sidePanel`
- `onboarding.overlay`
- `onboarding.canvas`
- `radial.overlay`
- `mini.shell`

The collector should keep raw events plus a summary grouped by profiler id:

- `mounts`
- `updates`
- `totalActualDurationMs`
- `maxActualDurationMs`
- `totalBaseDurationMs`
- `commitCount`
- `commitsOver8ms`
- `commitsOver16ms`
- `commitTimestamps`

## CDP Capture

Each scenario should capture:

- Chrome trace JSON with categories:
  - `devtools.timeline`
  - `v8`
  - `blink.user_timing`
  - `loading`
  - `disabled-by-default-v8.cpu_profiler`
  - `disabled-by-default-devtools.timeline`
- JS CPU profile for the measured window.
- Long-task entries from `PerformanceObserver`.
- Layout shift entries from `PerformanceObserver` where available.
- User timing marks emitted by the scenario and by the React profiler layer.
- Before/after memory from `Performance.getMetrics`.
- Optional Electron heap trace via `recordHeapTrace`.
- Screenshot at scenario start, midpoint when useful, and end.

Artifacts should be written as:

```text
state/outputs/perf/<run-id>/
  manifest.json
  summary.md
  scenarios/
    chat-stream/
      trace.json
      cpu.cpuprofile
      react-profile.json
      browser-metrics.json
      long-tasks.json
      layout-shifts.json
      screenshots/
        start.png
        end.png
```

## Scenario Matrix

Run every scenario at a desktop viewport and a mini-window viewport where the
surface exists. The first phase should cover macOS because Stella's desktop
shell, radial dial, mini window, capture, and fullscreen behavior are macOS
heavy. The harness should still keep the scenario definitions platform-aware so
Windows support can be added without rewriting coverage.

### Startup And Shell

- Cold full-window launch to home-ready.
- Warm full-window launch with persisted state.
- Toggle full sidebar from the top-bar control.
- Open sidebar hover popover and close it.
- Open mini window, close mini window, reopen mini window.
- Switch between home, settings, store, and social routes.

Budgets:

- No single React commit over 32 ms during route switches.
- No more than 1 long task over 100 ms after app-ready.
- Shell and top-bar should not update on high-frequency chat stream chunks
  unless their visible state changes.

### Chat Streaming

- Seed a long conversation with mixed user, assistant, tool, artifact, and
  activity rows.
- Start a deterministic local stream with small text chunks.
- Stream reasoning chunks and visible assistant text concurrently.
- Append footer task updates while streaming.
- Queue a follow-up user message during an active stream.
- Stop a stream.
- Load older messages.
- Scroll away from bottom, stream, then return to bottom.

Budgets:

- `chat.timeline` should batch stream chunks; it should not commit once per
  raw chunk.
- `chat.composer` should not update from stream text unless send/stop state or
  context chips change.
- No `chat.timeline` commit over 16 ms during steady streaming.
- No full shell commit caused by a footer task update.
- Long conversation route should stay below a scenario-defined max DOM node
  count.

### Composer And Context

- Type text into full composer and sidebar composer.
- Attach recent file.
- Add window capture chip fixture.
- Add region capture chip fixture.
- Remove chips.
- Open composer `+` menu, toggle read-aloud, close menu.
- Dictation states: idle, recording-with-empty-text, recording-with-text.

Budgets:

- Typing should update only composer-local profiler regions.
- Adding/removing chips should not re-render the full timeline.
- Menu open/close should not trigger display sidebar or store route commits.

### Display Sidebar

- Open Chat tab.
- Open artifact preview tab from a seeded chat artifact.
- Open HTML/canvas artifact card.
- Switch display tabs.
- Resize panel through pointer drag.
- Toggle expanded panel.
- Close and reopen panel.

Budgets:

- Resize should update `display.sidebar` layout state but not tab content on
  every pointer move.
- Tab strip should update on active tab changes, not on every panel-width
  change.
- No iframe/live-preview capture should be required for artifact thumbnails.

### Settings And Model Picker

- Open Settings.
- Search across settings.
- Open Models.
- Switch Assistant, Image, and Voice tabs in sidebar picker.
- Switch full Settings model tabs.
- Refresh catalog.
- Select a Stella mode.
- Open provider catalog.
- Select connected provider option.
- Change reasoning effort.

Budgets:

- Switching picker tabs should not remount the entire settings page.
- Connected provider switching should not flash/re-render unrelated picker
  sections.
- Catalog refresh should update model rows without re-rendering top-level shell
  regions.

### Store

- Open Store Discover.
- Switch Discover, Installed, Published, Fashion.
- Open Store side panel.
- Select multiple recent-change chips.
- Open connector/install confirmation dialog.
- Confirm a no-auth install fixture.
- Open pet card confirmation fixture.

Budgets:

- Store route tab switching should stay within route-local profiler regions.
- Store side panel thread updates should not re-render main chat.
- Dialog open/close should not trigger unrelated display sidebar commits.

### Onboarding

- Reset onboarding state in a temporary user-data dir.
- Step through intro, extension, capabilities, permissions, voice, memory,
  shortcuts, personality, theme, browser, creation, and enter phases.
- Verify progressive disclosure animations without layout shift.
- Exercise canvas-heavy phases with Stella animation paused where intended.

Budgets:

- Onboarding phase changes should not remount the whole app root.
- Capabilities and canvas phases should stay under the per-frame main-thread
  budget after their initial mount.
- No Suspense fallback should appear after the first preloaded transition.

### Radial, Capture, And Overlay

- Open radial dial from key chord.
- Dismiss by outside click.
- Trigger chat action in pinned and unpinned mini states.
- Trigger capture action and cancel.
- Trigger capture action and accept fixture region.

Budgets:

- Opening/dismissing radial should not focus or render the full app window when
  the mini flow is active.
- Capture cancel should restore last-focused window without full-window flash.
- Overlay animation should not introduce long tasks over 50 ms.

### Activity And Recent Files

- Seed Now, Done, Up Next, and Recent Files.
- Open Chat tab activity surface.
- Click scheduled item to open schedule dialog.
- Open recent HTML file.
- Update activity while Chat tab is open.

Budgets:

- Activity updates should not re-render chat message rows.
- Done shimmer/glow should render once for the latest item only.
- Recent file updates should stay below route-local commit budgets.

## Test Data And Determinism

Use temporary user data and temporary Stella state per run. The runner should
copy only the fixtures required for the scenario:

- local chat transcripts
- local activity rows
- recent file records
- generated output files
- store package fixtures
- model catalog fixtures
- onboarding preference state

Do not run live model requests, live Store backend calls, live OAuth, or real
capture APIs in the perf suite. Those are correctness/integration surfaces, not
stable performance baselines.

## Budget Files

Budgets should be checked in as JSON so the runner can fail with a useful diff:

```text
desktop/tests/perf/budgets/
  default.json
  macos.json
  mini.json
```

Example shape:

```json
{
  "chat-stream": {
    "maxLongTasksOver50ms": 0,
    "maxLongTasksOver100ms": 0,
    "maxReactCommitMs": {
      "chat.timeline": 16,
      "chat.composer": 8,
      "shell.full": 8
    },
    "maxReactCommits": {
      "shell.topbar": 2,
      "display.sidebar": 0
    },
    "maxHeapGrowthMb": 24
  }
}
```

The first implementation should record baselines without failing CI, then flip
stable budgets to blocking after two or three clean local runs.

## Commands

Target root scripts:

```json
{
  "perf:ui": "bun desktop/tests/perf/run.mjs",
  "perf:ui:record": "bun desktop/tests/perf/run.mjs --record-baseline",
  "perf:ui:scenario": "bun desktop/tests/perf/run.mjs --scenario"
}
```

Verification for harness changes:

```sh
bun run routes:generate
cd desktop && tsgo -p tsconfig.app.json --pretty false --noEmit
bun run electron:typecheck
bun desktop/tests/perf/run.mjs --scenario chat-stream --record-baseline
```

Use `tsgo`, not literal `tsc`, for checked-in scripts and docs that agents will
copy into automation.

## Rollout Plan

1. Add the profiler collector and inert `ProfilerBoundary` wrappers.
2. Add the Electron/CDP launch runner with one scenario that only opens the app
   and writes artifacts.
3. Add deterministic fixture injection for local chat, activity, recent files,
   display tabs, model catalog, store records, and onboarding state.
4. Implement the scenario matrix above.
5. Add baseline recording mode and human-readable summaries.
6. Add budget comparison in warning mode.
7. Promote stable budgets to failing local checks.
8. Add a slower scheduled CI job or local automation for the full suite; keep
   PR checks focused on the highest-risk subset unless the user asks for every
   scenario on every change.

## Failure Output

Failures should be written for engineers, not just machines:

- scenario name
- failed budget
- expected vs actual
- top React profiler ids by commit time
- top CPU profile functions
- longest tasks with stack/event labels when available
- screenshots path
- trace path
- likely ownership hints based on profiler id

Example:

```text
chat-stream failed maxReactCommitMs.chat.timeline
Expected <= 16 ms, saw 27.4 ms.
Top commits:
- chat.timeline 27.4 ms at +3.82 s
- chat.timeline 19.1 ms at +4.07 s
Likely area: desktop/src/app/chat/ChatTimeline.tsx or row transforms feeding it.
Trace: state/outputs/perf/2026-05-19T.../scenarios/chat-stream/trace.json
```

