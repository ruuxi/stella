---
name: stella-computer
description: Control Windows desktop apps through Stella's persistent Computer Use runtime.
---

# Stella Computer for Windows

Use `node_repl` for desktop-app work. The persistent JavaScript runtime is already initialized and exposes a frozen `sky` client. Bindings and delivered app instructions persist for this agent session.

## Observe

Start each desktop-app turn with fresh state:

```js
var state = await sky.get_app_state({
  app: "Spotify",
  screenshot_policy: "auto",
});
nodeRepl.write(state.text);
if (state.screenshot) await nodeRepl.emitImage(state.screenshot.url);
```

Use `await sky.list_apps()` only when an app name cannot be resolved. Use `await sky.list_windows()` when the app has multiple top-level windows, then pass `window_id` instead of `app` to state and action calls.

The default state is a UI Automation diff when sufficient. A screenshot is returned only when visual context is needed. Prefer numbered `element_index` values over coordinates.

Pass `disable_diff: true` only when you need a complete recovery tree.

## Act

Actions return after dispatch without rebuilding state or capturing a screenshot:

```js
await sky.click({ app: "Spotify", element_index: 42 });
await sky.set_value({ app: "Spotify", element_index: 18, value: "Daft Punk" });
await sky.perform_secondary_action({
  app: "Spotify",
  element_index: 9,
  action: "Invoke",
});
await sky.scroll({
  app: "Spotify",
  element_index: 55,
  direction: "down",
  pages: 1,
});
await sky.drag({
  app: "Spotify",
  from_x: 420,
  from_y: 310,
  to_x: 720,
  to_y: 310,
});
await sky.press_key({ app: "Spotify", key: "Return" });
await sky.type_text({ app: "Spotify", text: "hello" });
```

`drag` also accepts `path: [{ x, y }, ...]` with at least two points. Drag
coordinates must come from the latest screenshot; observe again after the drag.

Perform several actions before observing only when no intermediate result is needed. Then call `get_app_state` once and re-derive fresh indices. `sky.batch([...])` executes ordered actions and stops on the first failure; do not batch across decision points, permission prompts, or navigation-policy boundaries.

## Text Selection

Use semantic selection when the target exposes a UI Automation text range:

```js
await sky.select_text({
  app: "Notepad",
  element_index: 7,
  text: "matching text",
  prefix: "optional text before",
  suffix: "optional text after",
  selection_type: "text",
});
```

`selection_type` may be `text`, `cursor-before`, or `cursor-after`. Prefix and suffix disambiguate repeated matches.

## Coordinates And Input

For a visible control missing from the tree, use screenshot pixel coordinates from the latest attached screenshot:

```js
await sky.click({ window_id: 123456, x: 620, y: 412 });
```

Windows background input varies by framework. Prefer UI Automation elements first. Coordinate and keyboard delivery may briefly require foreground dispatch; verify the result with one final settled state.

Do not add sleeps. `get_app_state` performs adaptive settling and extends its wait only while UI Automation events indicate continued changes.

Do not use PowerShell, registry edits, app-bundle paths, or app-specific scripting to drive desktop apps. Use `exec_command` only to diagnose the Computer Use runtime itself.
