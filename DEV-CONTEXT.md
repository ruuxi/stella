# Dev Context for Stella (read me first)

This file exists so I (the user) don't have to keep re-explaining the same
ground truths to agents. If you're an agent working in this repo, read this
before suggesting "fixes" to the things below — they are intentional.

## TL;DR

- You're inside `/Users/rahulnanda/projects/stella` — the **dev tree**, not an
  installed copy of Stella.
- Stella ships as **source + Bun + Vite + Electron in dev mode**, run by a
  `launch.sh` the launcher writes. There is no packaged `.app`, and that is
  the shipping configuration, not a dev shortcut.
- The launcher is a Tauri Setup app that downloads a tarball, runs
  `bun install`, and `git init`s the install. It is not a normal `.dmg`/`.msi`
  installer because Stella self-modifies and updates as diffs.
- Stella has **one root `package.json` and one root `node_modules`**. There is
  intentionally no `desktop/package.json` or `runtime/package.json`; add
  dependencies from the repo root with `bun add <pkg>`.
- Native binaries under `desktop/native/out/` are **committed on purpose**.
- `~/projects/stella` (here) ≠ `~/stella` (an end-user-style install). Both
  may exist; only this one is the source of truth.

---

## Package and contract layout

Stella is one app split across folders, not a Bun workspace:

- Root `package.json` owns all desktop + runtime dependencies and scripts.
- Root `node_modules/` is the only dependency install location.
- `desktop/` is the Electron host + Vite renderer.
- `runtime/` is the agent kernel, worker, client SDK, and runtime-owned
  contracts.
- `runtime/contracts/` is the single source for runtime/shared contracts.
- `desktop/src/shared/contracts/` is only for truly desktop-only contracts
  (`ipc-channels`, display/sidebar payloads, pet/UI/onboarding, etc.).

**For agents:**

- Don't reintroduce `desktop/package.json`, `runtime/package.json`, Bun
  workspaces, or per-folder `node_modules`.
- Run `bun install`, `bun add`, `bun run electron:typecheck`, and
  `bun run electron:dev` from the repo root.
- If a contract is consumed by runtime or crosses the host/runtime boundary,
  put it in `runtime/contracts/`; don't create desktop shim duplicates.

---

## Why it's a dev server, not a packaged app

Stella's defining product trait is that the in-app general agent **writes code
that modifies Stella itself**. Vite HMR + the morph overlay
(`desktop/electron/self-mod/`,
`desktop/src/shell/overlay/MorphTransition.tsx`) hide the reload flash so the
edit appears seamless to the user.

That only works when the running app is the source tree, not a frozen bundle.
So:

- Stella ships as source. End users run `bun run electron:dev` via the
  `launch.sh` the launcher writes — same command the dev tree uses.
- The Store install flow installs **human-readable code commits**, not opaque
  packaged plugins. The install-update agent applies them as diffs against the
  user's current tree.
- HMR, the morph capture, and the run-scoped self-mod commit pipeline are all
  part of the prod UX, not just developer tooling.

**For agents:**

- Don't propose `electron-builder`, `.app` packaging, ASAR bundles, or any
  "freeze the source tree" approach for the normal app. There is no production
  packaged build — the dev server *is* production.
- Don't be confused that `bun run electron:dev` is what runs in production.
  It's not a hack. It's the shipping configuration.
- HMR-related plumbing (`runtime/host/index.ts` worker pause/restart, the
  Vite load-hook overlay in `desktop/vite.config.ts`) is load-bearing — don't
  remove it because "users wouldn't hit this".

---

## Why the launcher installs the way it does

`launcher/src-tauri/src/setup.rs` is the source of truth. End-user install
flow:

1. User runs `StellaSetup` (Tauri app, macOS binary `StellaSetup`).
2. Launcher checks/installs `bun` globally (`~/.bun/bin/bun`).
3. Downloads `stella-desktop-<platform>.tar.zst` from the R2 manifest
   (`DEFAULT_DESKTOP_RELEASE_MANIFEST_URL`), falling back to the GitHub release
   asset for `desktop-v*` tags. Verifies SHA256 when the manifest provides it.
4. Extracts into the install dir (default `~/stella`, enforced by
   `INSTALL_DIR_NAME = "stella"`). `state/` entries that already exist are
   preserved across reinstalls.
5. Writes a default `desktop/.env.local`, runs `bun install --frozen-lockfile`.
6. (macOS arm64 only) Downloads the Parakeet Core ML on-device dictation model
   into `desktop/resources/parakeet/`.
7. Writes a `launch.sh` (or `launch.cmd` on Windows) that `cd`s in and runs
   `bun run electron:dev`, with `dugite`-vendored `git` injected on `PATH`.
8. `init_git_repo()` does `git init` → `git add -A` → `git commit -m "start"`
   and records the start SHA in the install manifest. Self-mod commits accrue
   on top of that history.

Why not a normal installer (DMG/MSI):

- Self-mod requires a real git repo at the install root. Packaged apps don't
  have one.
- Updates are applied as **diffs** on top of the user's possibly-diverged
  tree by a constrained install-update agent. The user's code can legitimately
  drift from the shipped release because they accepted Store mods or
  self-modded. A traditional installer would clobber that.
- The launcher is the only setup surface — there is no notarized `.app`
  download.
- The bundled `git` (via `dugite`) means we don't depend on the user having
  Xcode CLT installed.

**For agents:**

- Don't try to refactor the launcher into a "normal" installer.
- Don't add tarball-overwrite or `git apply --reset` shortcuts to the update
  flow — the install-update agent resolves merge conflicts inline by design,
  and a small drift between the user's tree and the source release is
  acceptable.
- `state/electron-user-data/` is the one thing the launcher deliberately
  wipes on reinstall (so a stale `stella-onboarding-complete` localStorage
  entry doesn't trap users in a dead onboarding screen). The rest of `state/`
  survives.
- The launcher refuses to install into a non-empty directory unless that
  directory looks like an existing Stella install or contains only `state/` —
  don't loosen this.

---

## Why we commit native build outputs (`desktop/native/out/`)

`desktop/native/out/darwin/` and `desktop/native/out/win32/` contain prebuilt
binaries — `disclaim-spawn`, `wakeword_listener`, `parakeet_transcriber`,
`dictation_bridge`, `window_info`, `selected_text`, `screen_permission`,
`window_ocr`, `desktop_automation`, `home_apps`, `home_capture`, `chronicle`.

They are **tracked in git on purpose**. Note the deliberately-commented line
in `desktop/.gitignore`:

```
# native/out/
```

Reasons:

- The launcher install path is `download tarball → bun install → run`. There
  is **no native compile step** in install. Requiring users to have `clang`,
  `swiftc`, `cargo`/`rustup`, or MSVC would break "just install it".
- Several of these binaries gate core features:
  - `disclaim-spawn` — TCC permission responsibility on macOS dev launches.
  - `wakeword_listener` — "Hey Stella" wake-word detection.
  - `parakeet_transcriber` — on-device dictation (macOS arm64).
  - `dictation_bridge`, `selected_text`, `window_info`, `desktop_automation` —
    in-process AX / window control / dictation overlay.
  - `chronicle`, `home_capture`, `home_apps` — Chronicle live memory and the
    home active-window/tab capture chips.
- Missing binaries in a shipped tarball = broken core features at install
  time, not "graceful degradation". The launcher's "skip if missing" branches
  are for dev contributors who haven't built that platform's helpers, not for
  end users.

**For agents:**

- Don't add `desktop/native/out/` to `.gitignore`. It's load-bearing.
- If you change a source file under `desktop/native/src/` or
  `desktop/native/wakeword/`, run `desktop/native/build.sh` (macOS) or the
  matching `build.ps1` / `build.mjs`, then **commit the rebuilt binary
  alongside the source change** in the same commit.
- Treat a missing binary under `desktop/native/out/<platform>/` like a missing
  dependency, not a build artifact to ignore.

---

## Why this repo lives at `~/projects/stella`, not `~/stella`

| Path | What it is |
| --- | --- |
| `/Users/rahulnanda/projects/stella` (here) | **Dev tree.** Source of truth. Where edits happen, commits land, `desktop-v*` tags get pushed. |
| `~/stella` (or wherever the launcher installed) | **End-user install.** Same shape, but extracted from a release tarball by `StellaSetup`. End users only ever have this. |

Both directories run the same `bun run electron:dev` command and look very
similar on disk. They're kept separate so:

- Self-mod commits the running Stella app generates during testing don't
  pollute the dev tree being authored. Self-mod runs against whichever tree
  the running app was launched from — usually `~/stella` for install-flow
  testing.
- The author can keep a clean user-style install of Stella alongside the dev
  tree to verify the install / update / launcher flow end-to-end.
- The launcher's `INSTALL_DIR_NAME = "stella"` convention (it auto-appends
  `stella/` to any chosen parent directory) makes `~/stella` the canonical
  user install path, so the dev tree intentionally lives elsewhere to avoid
  colliding with it.

**For agents:**

- "The Stella code" = this directory (`~/projects/stella`), unless I'm
  explicitly debugging something inside an installed copy.
- `~/stella` on this machine, if it exists, is a user install — treat it like
  one. Don't `git pull` into it, don't push from it, don't edit it as if it
  were the source tree.
- Inside Stella's runtime, `stellaRoot` and `~/.stella` refer to whichever
  install the running app was launched from. From that perspective, the dev
  tree here is just "the install Stella happens to be running out of right
  now".
