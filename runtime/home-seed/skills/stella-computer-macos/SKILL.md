---
name: stella-computer
description: Control macOS desktop apps through Stella's persistent Computer Use runtime.
---

# Stella Computer for macOS

Use `node_repl` for desktop-app work. The persistent JavaScript runtime is already initialized and exposes a frozen `sky` client. Bindings and delivered app instructions persist for this agent session.

## Observe

Start each desktop-app turn with fresh state for the named app:

```js
var state = await sky.get_app_state({
  app: "Spotify",
  screenshot_policy: "auto",
});
nodeRepl.write(state.text);
if (state.screenshot) await nodeRepl.emitImage(state.screenshot.url);
```

Use the app name directly. Call `await sky.list_apps()` only when the requested app cannot be resolved.
Call `await sky.list_windows()` when window titles or native window IDs are needed to disambiguate several top-level windows.

The default state is an accessibility-tree diff when that is sufficient. A screenshot is returned only when visual context is needed. Prefer the accessibility text and numbered `element_index` values; inspect the screenshot when the tree is sparse or the visible control is absent.

Pass `disable_diff: true` only when you need a complete recovery tree.

## Act

Actions return after dispatch without rebuilding state or capturing a screenshot:

```js
await sky.click({ app: "Spotify", element_index: 42 });
await sky.set_value({ app: "Spotify", element_index: 18, value: "Daft Punk" });
await sky.perform_secondary_action({
  app: "Spotify",
  element_index: 9,
  action: "Show Menu",
});
await sky.scroll({
  app: "Spotify",
  element_index: 55,
  direction: "down",
  pages: 1,
});
await sky.press_key({ app: "Spotify", key: "Return" });
await sky.type_text({ app: "Spotify", text: "hello" });
```

Perform one or more actions in one `node_repl` call only when no intermediate result is needed. Then fetch settled state once:

```js
await sky.click({ app: "Spotify", element_index: 18 });
await sky.set_value({ app: "Spotify", element_index: 18, value: "Daft Punk" });
var nextState = await sky.get_app_state({
  app: "Spotify",
  screenshot_policy: "auto",
});
nodeRepl.write(nextState.text);
if (nextState.screenshot) await nodeRepl.emitImage(nextState.screenshot.url);
```

For a data-driven sequence, `sky.batch([...])` executes actions in order and stops on the first failure. Do not batch across a decision point, permission prompt, navigation-policy boundary, or any step whose result determines the next action.

Always re-derive element indices from the latest state. Cached native element handles may be refetched safely, but stale indices must not be guessed after the interface changes.

## Text Selection

Use semantic selection instead of repeated arrow-key commands:

```js
await sky.select_text({
  app: "TextEdit",
  element_index: 7,
  text: "matching text",
  prefix: "optional text before",
  suffix: "optional text after",
  selection_type: "text",
});
```

`selection_type` may be `text`, `cursor-before`, or `cursor-after`. Prefix and suffix disambiguate repeated matches.

## Coordinates And Input

Use accessibility elements whenever possible. For a visible control missing from the tree, use screenshot pixel coordinates from the latest attached screenshot:

```js
await sky.click({ app: "Spotify", x: 620, y: 412 });
```

Coordinate and keyboard actions may affect the active input path. Use them only when the semantic accessibility route is unavailable, and verify with one final `get_app_state`.

Spotify and other Chromium/Electron apps can expose sparse state briefly. Do not add sleeps; `get_app_state` performs adaptive settling and waits longer only while the app continues changing.

Do not use AppleScript, `osascript`, `open -a`, app-bundle internals, or shell commands to drive desktop apps. Use `exec_command` only to diagnose the Computer Use runtime itself.
