# Self-Mod Morph Replay

Use this note when recreating the temporary self-mod morph harness for HMR,
covered renderer reload, and process-restart experiments.

## Replay Script

The helper script is:

```sh
node desktop/scripts/replay-interstellar-self-mod.mjs
node desktop/scripts/replay-interstellar-self-mod.mjs --reload
```

It writes `.stella-selfmod-replay-request.json` and waits for
`.stella-selfmod-replay-result.json`. It expects a temporary host-side dev hook
to consume that request, apply files one by one with a delay, call
`beginExternalSelfMod`, then call `finishExternalSelfMod`.

The script intentionally does not ship a permanent runtime hook. Recreate the
host hook only while debugging, then remove it before release.

## Test Shape

The HMR case adds an `Interstellar` theme payload:

- copy a generated image from `~/.stella/media/outputs`
- add `desktop/src/shared/theme/themes/interstellar.ts`
- register it in `desktop/src/shared/theme/themes/index.ts`
- add image-backed rendering in `ShiftingGradient`
- auto-select the theme after registration so screenshot 2 visibly changes

The reload case does the same and additionally touches `desktop/index.html`,
which is classified by `runtime/kernel/self-mod/path-relevance.ts` as a
full-window reload path.

## Findings

The real bug was not DOM readiness or gradient paint timing. The replay was
creating/registering Interstellar without selecting it, so screenshot 2 could
still be the old Pearl/white theme.

For production behavior, the important fix is general-purpose:

- if Vite reports a client full reload, perform a covered renderer reload
- if HMR leaves the renderer on the error boundary, recover with a covered
  renderer reload
- hide the boot splash only for morph-covered reloads via the
  `stella:morph-reload` session flag

Do not keep Interstellar files, request/result JSON, copied images, or the
temporary host request watcher in a release commit.
