import { AsyncLocalStorage } from "node:async_hooks"
import fs from "fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite"
import {
  isViteTrackablePath,
  normalizeContentionPath,
} from "../runtime/kernel/self-mod/path-relevance.js"

/**
 * Per-request flag that bypasses the self-mod pre-period snapshot for
 * Node-side callers (no `Origin` header on localhost — see
 * `isAuthorizedSelfModRequest`). The snapshot exists to keep the
 * **renderer** stable mid-run; for the worker / the agent itself
 * curl-verifying its own writes, "truth" is what's on disk right now.
 * Without this bypass, an agent that writes a renderer file mid-run
 * and verifies via `curl http://localhost:57314/src/...` keeps seeing
 * the pre-edit snapshot and concludes Vite is broken.
 *
 * `dirtiedModulePaths` collects every tracked path the worker pulled
 * raw disk for during this request; after the response finishes we
 * invalidate those module graph entries so the renderer's next read
 * re-runs `load()` and gets the snapshot back. Without this scrub,
 * Vite's transform cache would happily serve the worker's disk view
 * to the next renderer request, defeating mid-run isolation.
 */
const selfModRequestContext = new AsyncLocalStorage<{
  bypassSelfModOverlay: boolean
  dirtiedModulePaths: Set<string>
}>()

const DEV_URL_FILE = path.resolve(__dirname, '.vite-dev-url')
const SELF_MOD_HMR_ENDPOINT_BASE = '/__stella/self-mod/hmr'
const STELLA_REPO_ROOT = path.resolve(__dirname, '..')
const SELF_MOD_RUNTIME_RELOAD_STATE_FILE = path.resolve(
  STELLA_REPO_ROOT,
  '.stella-runtime-reload-state.json',
)
const STELLA_STATE_DIR = path.resolve(__dirname, '..', 'state')
const VITE_WORKSPACE_ROOT = searchForWorkspaceRoot(__dirname)

const normalizeWatchedFilePath = (filePath: string) =>
  path.resolve(filePath).replace(/\\/g, '/')

const PDF_WORKER_PUBLIC_REL = path.posix.join('vendor', 'pdfjs', 'pdf.worker.min.mjs')
const PDF_WORKER_PUBLIC_ABS = path.resolve(__dirname, 'public', PDF_WORKER_PUBLIC_REL)

/**
 * Copies the pdfjs-dist worker into `public/vendor/pdfjs/` so the renderer
 * can load it as a static asset, served by Vite's dev server and emitted
 * verbatim into `dist/` at build time.
 *
 * We can't rely on Vite/Rolldown to resolve the deep package path with
 * `?url`: the bun-managed node_modules layout hides pdfjs-dist behind
 * `.bun/node_modules/` and the deep path probe (`new URL("pdfjs-dist/...")`)
 * only sees Vite's import-map resolver, which doesn't expose deep file
 * paths through that channel. Copying via Node's resolver is the most
 * portable path: it works under bun's symlink layout, npm's flat layout,
 * and pnpm's strict-peer layout.
 */
function pdfWorkerAsset(): Plugin {
  const candidatePaths = [
    // wojtekmaj/react-pdf nests pdfjs-dist as its own dependency, which is
    // the most stable resolution target across package managers.
    path.resolve(
      STELLA_REPO_ROOT,
      'node_modules',
      '.bun',
      'node_modules',
      'pdfjs-dist',
      'build',
      'pdf.worker.min.mjs',
    ),
    path.resolve(
      STELLA_REPO_ROOT,
      'node_modules',
      'pdfjs-dist',
      'build',
      'pdf.worker.min.mjs',
    ),
  ]

  const resolveSource = (): string | null => {
    for (const candidate of candidatePaths) {
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate
        }
      } catch {
        /* try next */
      }
    }
    return null
  }

  const ensureWorkerCopied = () => {
    const sourcePath = resolveSource()
    if (!sourcePath) {
      console.warn(
        '[pdf-worker-asset] Could not locate pdfjs-dist/build/pdf.worker.min.mjs; PDF previews will not render.',
      )
      return
    }
    const destPath = PDF_WORKER_PUBLIC_ABS
    fs.mkdirSync(path.dirname(destPath), { recursive: true })

    let needsCopy = true
    try {
      const sourceStat = fs.statSync(sourcePath)
      const destStat = fs.statSync(destPath)
      if (destStat.size === sourceStat.size && destStat.mtimeMs >= sourceStat.mtimeMs) {
        needsCopy = false
      }
    } catch {
      needsCopy = true
    }

    if (needsCopy) {
      fs.copyFileSync(sourcePath, destPath)
    }
  }

  return {
    name: 'pdf-worker-asset',
    configResolved() {
      ensureWorkerCopied()
    },
  }
}

/** Writes the resolved dev server URL to .vite-dev-url so Electron can discover it. */
function devServerUrl(): Plugin {
  return {
    name: 'dev-server-url',
    configureServer(server) {
      try {
        fs.unlinkSync(DEV_URL_FILE)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address()
        if (addr && typeof addr === 'object') {
          // Derive the URL from the actual bound address so the dev URL
          // and the listener can never disagree. Hardcoding `localhost`
          // here used to race against Chromium's resolver picking an
          // address family the http server hadn't bound (e.g. Vite binds
          // ::1 only, Chromium tries 127.0.0.1 first → ERR_CONNECTION_REFUSED).
          const host =
            addr.family === 'IPv6' ? `[${addr.address}]` : addr.address
          fs.writeFileSync(DEV_URL_FILE, `http://${host}:${addr.port}`)
        }
      })
    },
  }
}

type ApplyRunPayload = { runId?: unknown; paths?: unknown; files?: unknown }
type ApplyPayload = {
  runs?: ApplyRunPayload[]
  options?: {
    suppressClientFullReload?: unknown
    forceClientFullReload?: unknown
  }
}
type TrackPayload = { paths?: unknown }
type PausePayload = { runId?: unknown; runIds?: unknown }

export const resolveSelfModHmrAbsolutePath = (repoRelative: string): string | null => {
  if (typeof repoRelative !== 'string' || repoRelative.length === 0) return null
  if (path.isAbsolute(repoRelative)) return null
  if (repoRelative.includes('\0')) return null
  const resolved = path.resolve(STELLA_REPO_ROOT, repoRelative)
  const relative = path.relative(STELLA_REPO_ROOT, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved.replace(/\\/g, '/')
}

const stripIdSuffix = (id: string): string => {
  const queryIdx = id.indexOf('?')
  const hashIdx = id.indexOf('#')
  let end = id.length
  if (queryIdx !== -1) end = Math.min(end, queryIdx)
  if (hashIdx !== -1) end = Math.min(end, hashIdx)
  return id.slice(0, end)
}

const normalizeIdKey = (id: string): string => {
  const stripped = stripIdSuffix(id).replace(/\\/g, '/')
  // Vite sometimes prefixes resolved fs paths with `/@fs/`; strip it so the
  // overlay key matches whichever form the worker reports (always absolute).
  if (stripped.startsWith('/@fs/')) {
    return stripped.slice('/@fs'.length)
  }
  return stripped
}

const SELF_MOD_OVERLAY_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs']
const SELF_MOD_OVERLAY_INDEX_FILES = [
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
]

const isViteTrackableAbsolutePath = (absPath: string): boolean => {
  const repoRelative = normalizeContentionPath(absPath, STELLA_REPO_ROOT)
  return repoRelative != null && isViteTrackablePath(repoRelative)
}

export const resolveSelfModOverlayImportPath = (
  source: string,
  importer: string | undefined,
  hasOverlayPath: (absPath: string) => boolean,
): string | null => {
  if (!source || source.includes('\0')) return null
  if (!importer || source.startsWith('\0')) return null
  if (!source.startsWith('.') && !path.isAbsolute(source)) return null

  const importerPath = normalizeIdKey(importer)
  if (!path.isAbsolute(importerPath)) return null

  const basePath = path.isAbsolute(source)
    ? source
    : path.resolve(path.dirname(importerPath), source)
  const normalizedBase = path.resolve(basePath).replace(/\\/g, '/')

  const candidates = new Set<string>()
  if (path.extname(normalizedBase)) {
    candidates.add(normalizedBase)
  } else {
    for (const ext of SELF_MOD_OVERLAY_EXTENSIONS) {
      candidates.add(`${normalizedBase}${ext}`)
    }
    for (const indexFile of SELF_MOD_OVERLAY_INDEX_FILES) {
      candidates.add(path.resolve(normalizedBase, indexFile).replace(/\\/g, '/'))
    }
  }

  for (const candidate of candidates) {
    if (!isViteTrackableAbsolutePath(candidate)) continue
    if (hasOverlayPath(candidate)) return candidate
  }
  return null
}

const readDiskOrEmpty = (absPath: string): string => {
  try {
    return fs.readFileSync(absPath, 'utf-8')
  } catch {
    // File may not exist yet (newly-created path mid-flight) or may have been
    // deleted; treat as empty so load() can return a stable, non-throwing
    // module body until apply lands.
    return ''
  }
}

const reconcileAppliedOverlayFileToDisk = (file: {
  absPath: string
  content: string | null
  deleted: boolean
}): boolean => {
  if (file.deleted) {
    try {
      fs.rmSync(file.absPath, { force: true })
      return true
    } catch (error) {
      console.warn(
        '[self-mod-hmr] Failed to delete applied overlay file:',
        file.absPath,
        (error as Error).message,
      )
      return false
    }
  }

  try {
    fs.mkdirSync(path.dirname(file.absPath), { recursive: true })
    fs.writeFileSync(file.absPath, file.content ?? '', 'utf-8')
    return true
  } catch (error) {
    console.warn(
      '[self-mod-hmr] Failed to write applied overlay file:',
      file.absPath,
      (error as Error).message,
    )
    return false
  }
}

/**
 * Self-mod HMR endpoints are gated by two coordinated defenses, neither of
 * which is a shared secret token:
 *
 *   1. Vite binds the dev server to localhost only, so remote network
 *      attackers can never reach `/__stella/self-mod-hmr/*` in the first
 *      place. We re-verify the socket peer here to defeat any oddball
 *      reverse-proxy / SSRF scenario.
 *   2. We require the request to have NO `Origin` header. Browser fetches
 *      always set Origin (and cross-origin requests with a JSON body
 *      trigger preflight, which Vite does not authorize). Our worker
 *      uses Node's `fetch` which omits Origin by default, so legitimate
 *      worker traffic passes while any browser-side caller -- malicious
 *      tab, our own renderer, an extension -- is blocked.
 *
 * Same-UID malicious processes are out of scope: anything running as the
 * user can already manipulate Stella's files / signals / IPC, so a shared
 * token bought us nothing real against that threat.
 */
const isAuthorizedSelfModRequest = (
  req: import('node:http').IncomingMessage,
): boolean => {
  const remoteAddress = req.socket.remoteAddress ?? ''
  const origin = req.headers.origin
  return (
    origin == null &&
    (remoteAddress === '127.0.0.1' ||
      remoteAddress === '::1' ||
      remoteAddress === '::ffff:127.0.0.1')
  )
}

const DELETED_OVERLAY_MODULE = 'throw new Error("This module was deleted by Stella self-mod.");\n'

const SHELL_SNAPSHOT_ROOTS = [
  path.resolve(STELLA_REPO_ROOT, 'desktop', 'src'),
]
const SHELL_SNAPSHOT_EXPLICIT_FILES = [
  'desktop/index.html',
]
const SHELL_SNAPSHOT_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  '.bun',
  '.cache',
  '.vite',
  '.turbo',
  '.next',
  'build',
  'coverage',
  'out',
  '.stella-state',
])
const SHELL_SNAPSHOT_EXCLUDED_SUFFIXES = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.mp4',
  '.mov',
  '.pdf',
  '.zip',
])

const isShellSnapshotCandidate = (absPath: string): boolean => {
  const lower = absPath.toLowerCase()
  for (const suffix of SHELL_SNAPSHOT_EXCLUDED_SUFFIXES) {
    if (lower.endsWith(suffix)) return false
  }
  const repoRelative = normalizeContentionPath(absPath, STELLA_REPO_ROOT)
  return repoRelative != null && isViteTrackablePath(repoRelative)
}

const collectShellSnapshotFiles = (): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  const pushCandidate = (absPath: string) => {
    const normalized = path.resolve(absPath).replace(/\\/g, '/')
    if (seen.has(normalized) || !isShellSnapshotCandidate(normalized)) return
    seen.add(normalized)
    out.push(normalized)
  }
  const visit = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SHELL_SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue
        visit(absPath)
      } else if (entry.isFile() && isShellSnapshotCandidate(absPath)) {
        pushCandidate(absPath)
      }
    }
  }
  for (const root of SHELL_SNAPSHOT_ROOTS) {
    visit(root)
  }
  for (const relPath of SHELL_SNAPSHOT_EXPLICIT_FILES) {
    pushCandidate(path.resolve(STELLA_REPO_ROOT, relPath))
  }
  return out
}

/**
 * Implements per-run apply with a "pre-period snapshot" overlay so concurrent
 * Stella self-mod runs can't bleed each other's WIP into the renderer.
 *
 * State (all keyed by absolute, posix-style fs path):
 *   - inFlightPaths:      paths currently owned by some active or held run.
 *                          Disk writes to these are swallowed via handleHotUpdate;
 *                          load() serves prePeriodSnapshot to keep new module
 *                          loads stable until apply lands.
 *   - prePeriodSnapshot:  content captured the moment a path entered
 *                          inFlightPaths.
 *   - appliedOverlay:     content captured by the worker at run-finalize time
 *                          and sent with /apply. load() prefers this over disk
 *                          so cancelled or still-running agents cannot leak
 *                          their current disk contents into a held run's apply.
 *
 * Endpoints exposed under /__stella/self-mod/hmr:
 *   - POST /track-paths    { paths: string[] }  (repo-relative posix)
 *   - POST /untrack-paths  { paths: string[] }
 *   - POST /apply          { runs: [{ runId, files: [{ path, content }] }] }
 *   - POST /discard        { paths: string[] }  (drop pins/overlays for failed apply)
 *   - POST /begin-shell-mutation, /end-shell-mutation
 *   - POST /force-resume   (clear all state; emergency)
 *   - GET  /status         (debug introspection)
 */
function selfModHmrControl(): Plugin {
  const pausedRunIds = new Set<string>()
  const inFlightPaths = new Set<string>()
  const prePeriodSnapshot = new Map<string, string>()
  const appliedOverlay = new Map<string, { content: string; mtime: number }>()
  const shellSnapshotPaths = new Set<string>()
  const suppressedHotUpdatePaths = new Set<string>()
  // Paths whose synthetic watcher event was just emitted by `applyBatch`.
  // `handleHotUpdate` consumes (deletes) the entry on first hit so the
  // standard "pause gate returns []" suppression doesn't fire for the apply
  // path itself. The set is also cleared on a short timeout as a leak guard
  // in case the chain never fires.
  const recentlyEmittedSyntheticPaths = new Set<string>()
  let suppressedClientMessages = 0
  let clientUpdateReleaseDepth = 0
  let clientFullReloadRequestedDuringApply = false
  let shellMutationDepth = 0

  const isClientUpdatePaused = () =>
    pausedRunIds.size > 0 || shellMutationDepth > 0

  const pauseRun = (runId: string) => {
    if (runId.length > 0) pausedRunIds.add(runId)
  }

  const releaseRuns = (runIds: string[]) => {
    for (const runId of runIds) {
      pausedRunIds.delete(runId)
    }
    if (!isClientUpdatePaused()) {
      suppressedHotUpdatePaths.clear()
    }
  }

  const trackPath = (absPath: string) => {
    if (inFlightPaths.has(absPath)) return
    inFlightPaths.add(absPath)
    if (!prePeriodSnapshot.has(absPath)) {
      // Snapshot may be stale relative to the writer's current state, but
      // it's stable for the period — that's what the renderer needs.
      prePeriodSnapshot.set(absPath, readDiskOrEmpty(absPath))
    }
  }

  const untrackPath = (absPath: string) => {
    inFlightPaths.delete(absPath)
    prePeriodSnapshot.delete(absPath)
  }

  const trackShellSnapshotPath = (absPath: string) => {
    if (inFlightPaths.has(absPath)) return
    trackPath(absPath)
    shellSnapshotPaths.add(absPath)
  }

  const promoteSuppressedShellUpdatePaths = (): string[] => {
    const promoted: string[] = []
    for (const absPath of suppressedHotUpdatePaths) {
      if (!isViteTrackableAbsolutePath(absPath)) continue
      const repoRelative = normalizeContentionPath(absPath, STELLA_REPO_ROOT)
      if (!repoRelative) continue
      shellSnapshotPaths.delete(absPath)
      trackPath(absPath)
      promoted.push(repoRelative)
    }
    return promoted
  }

  const releaseShellSnapshotPaths = () => {
    for (const absPath of shellSnapshotPaths) {
      untrackPath(absPath)
    }
    shellSnapshotPaths.clear()
  }

  const clearAllState = () => {
    pausedRunIds.clear()
    inFlightPaths.clear()
    prePeriodSnapshot.clear()
    appliedOverlay.clear()
    shellSnapshotPaths.clear()
    suppressedHotUpdatePaths.clear()
    recentlyEmittedSyntheticPaths.clear()
    suppressedClientMessages = 0
  }

  const shouldSuppressClientMessage = (payload: unknown): boolean => {
    if (!isClientUpdatePaused() || clientUpdateReleaseDepth > 0) return false
    if (!payload || typeof payload !== 'object') return false
    const type = (payload as { type?: unknown }).type
    // While a self-mod run is paused (and the apply pipeline isn't running),
    // suppress everything that would visibly disturb the renderer:
    //   - `update` / `prune`: in-flight HMR for files we own — would leak
    //     pre-finalize WIP into the renderer.
    //   - `full-reload`: most commonly emitted by Vite's dep optimizer once
    //     a newly-imported package is registered (see
    //     `optimized dependencies changed. reloading` in Vite's source) and
    //     by config-dependency restarts. During a long agent run (e.g. the
    //     agent runs `bun add three` then writes a file that imports
    //     `three`) this used to yank the renderer to a fallback/recovery
    //     state mid-run. The covered reload at finalize already brings up
    //     the new module graph, so suppressing here is purely a UX win.
    //
    // For the dep-optimizer case specifically: `environment.hot === server.ws`
    // for the client environment, so intercepting `server.ws.send` already
    // catches BOTH `updateModules` page reloads and `optimizeDeps.fullReload`.
    // Don't add a separate `environment.hot.send` intercept "for completeness"
    // — that is the same channel.
    //
    // We deliberately do NOT suppress `error`. It doesn't navigate the page
    // and hiding it would mask real transform/parse failures the user should
    // still see in the renderer's overlay.
    //
    // React-Refresh recovery is preserved by `clientUpdateReleaseDepth > 0`
    // gating us off entirely while `applyBatch` runs (and slightly past it,
    // because Refresh's bail-out-then-`full-reload` round-trip is async).
    //
    // Concurrent-run edge case (accepted, not handled): if run A finalizes
    // while run B is still paused, A's React-Refresh bail-out reload could
    // be swallowed by B's pause window. Concurrent self-mod runs are rare,
    // and the next finalize's `reloadIgnoringCache` recovers the renderer.
    return type === 'update' || type === 'prune' || type === 'full-reload'
  }

  const withClientUpdateRelease = async <T,>(fn: () => Promise<T>): Promise<T> => {
    clientUpdateReleaseDepth += 1
    try {
      return await fn()
    } finally {
      clientUpdateReleaseDepth = Math.max(0, clientUpdateReleaseDepth - 1)
    }
  }

  return {
    name: 'stella-self-mod-hmr-control',
    enforce: 'pre',
    resolveId(source, importer) {
      return resolveSelfModOverlayImportPath(
        source,
        importer,
        (absPath) => appliedOverlay.has(absPath) || inFlightPaths.has(absPath),
      )
    },
    load(id) {
      const key = normalizeIdKey(id)
      const requestContext = selfModRequestContext.getStore()
      if (requestContext?.bypassSelfModOverlay) {
        // Node-side caller (worker, agent curl) — return null so Vite
        // falls back to disk. The agent must be able to verify its own
        // writes; only the renderer needs the stable snapshot. We tag
        // the path so the middleware can invalidate Vite's transform
        // cache after the response is flushed, preventing the worker's
        // disk view from poisoning subsequent renderer reads.
        if (appliedOverlay.has(key) || inFlightPaths.has(key)) {
          requestContext.dirtiedModulePaths.add(key)
        }
        return null
      }
      const overlay = appliedOverlay.get(key)
      if (overlay) {
        return overlay.content
      }
      if (inFlightPaths.has(key)) {
        return prePeriodSnapshot.get(key) ?? ''
      }
      return null
    },
    transformIndexHtml(html, ctx) {
      const key = normalizeIdKey(ctx.filename ?? path.resolve(__dirname, 'index.html'))
      if (!isViteTrackableAbsolutePath(key)) return html
      const requestContext = selfModRequestContext.getStore()
      if (requestContext?.bypassSelfModOverlay) {
        if (appliedOverlay.has(key) || inFlightPaths.has(key)) {
          requestContext.dirtiedModulePaths.add(key)
        }
        return html
      }
      const overlay = appliedOverlay.get(key)
      if (overlay) {
        return overlay.content
      }
      if (inFlightPaths.has(key)) {
        return prePeriodSnapshot.get(key) ?? html
      }
      return html
    },
    configureServer(server) {
      // Tag every Node-side request (no Origin, localhost) with an
      // AsyncLocalStorage context so the `load()` and
      // `transformIndexHtml` hooks downstream can serve real disk
      // content instead of the pre-period snapshot. Browser requests
      // always carry an Origin header and skip this branch, so the
      // renderer keeps its mid-run snapshot guarantees.
      //
      // We invalidate every tracked module graph entry both BEFORE
      // and AFTER the worker request runs:
      //   - Before: Vite caches transform results, so without
      //     pre-invalidation `load()` is never re-entered and the
      //     bypass branch can't take effect — the worker would get
      //     back whatever the renderer's last read cached.
      //   - After: the worker's disk view must not stay in the cache
      //     and leak to the next renderer request.
      const invalidateAllTrackedModules = () => {
        const trackedPaths = new Set<string>([
          ...inFlightPaths,
          ...appliedOverlay.keys(),
        ])
        for (const absPath of trackedPaths) {
          const mods = server.moduleGraph.getModulesByFile(absPath)
          if (!mods) continue
          for (const mod of mods) {
            server.moduleGraph.invalidateModule(mod)
          }
        }
      }
      server.middlewares.use((req, res, next) => {
        if (!isAuthorizedSelfModRequest(req)) {
          next()
          return
        }
        invalidateAllTrackedModules()
        const dirtiedModulePaths = new Set<string>()
        let scrubbed = false
        const scrubDirtiedModules = () => {
          if (scrubbed) return
          scrubbed = true
          invalidateAllTrackedModules()
        }
        res.once('close', scrubDirtiedModules)
        res.once('finish', scrubDirtiedModules)
        selfModRequestContext.run(
          { bypassSelfModOverlay: true, dirtiedModulePaths },
          next,
        )
      })

      const sendClientMessage = server.ws.send.bind(server.ws)
      server.ws.send = ((payload: unknown, ...args: unknown[]) => {
        if (
          clientUpdateReleaseDepth > 0 &&
          payload &&
          typeof payload === 'object' &&
          (payload as { type?: unknown }).type === 'full-reload'
        ) {
          clientFullReloadRequestedDuringApply = true
          suppressedClientMessages += 1
          return
        }
        if (shouldSuppressClientMessage(payload)) {
          suppressedClientMessages += 1
          return
        }
        return sendClientMessage(payload as never, ...(args as never[]))
      }) as typeof server.ws.send

      const readJsonBody = async (
        req: import('node:http').IncomingMessage,
      ): Promise<Record<string, unknown>> => {
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        if (chunks.length === 0) return {}
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          return parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : {}
        } catch {
          return {}
        }
      }

      const collectStringArray = (value: unknown): string[] => {
        if (!Array.isArray(value)) return []
        const out: string[] = []
        for (const entry of value) {
          if (typeof entry === 'string' && entry.length > 0) out.push(entry)
        }
        return out
      }

      const collectApplyFiles = (
        run: ApplyRunPayload,
      ): Array<{ absPath: string; content: string | null; deleted: boolean }> => {
        if (!Array.isArray(run.files)) return []
        const out: Array<{ absPath: string; content: string | null; deleted: boolean }> = []
        for (const entry of run.files) {
          if (!entry || typeof entry !== 'object') continue
          const file = entry as { path?: unknown; content?: unknown; deleted?: unknown }
          if (typeof file.path !== 'string') continue
          if (
            file.deleted !== true &&
            typeof file.content !== 'string'
          ) continue
            const absPath = resolveSelfModHmrAbsolutePath(file.path)
            if (!absPath) continue
            if (!isViteTrackableAbsolutePath(absPath)) continue
            out.push({
            absPath,
            content: typeof file.content === 'string' ? file.content : null,
            deleted: file.deleted === true,
          })
        }
        return out
      }

      const applyBatch = async (
        runs: Array<{
          runId: string
          files: Array<{ absPath: string; content: string | null; deleted: boolean }>
        }>,
        options?: {
          suppressClientFullReload?: boolean
          forceClientFullReload?: boolean
        },
      ): Promise<{
        appliedPaths: number
        reloadedModules: number
        requiresClientFullReload: boolean
      }> =>
        withClientUpdateRelease(async () => {
        clientFullReloadRequestedDuringApply = false
        let reloadedModules = 0
        let appliedPaths = 0
        const suppressClientFullReload =
          options?.suppressClientFullReload === true
        const forceClientFullReload =
          options?.forceClientFullReload === true
        const modulesToReload: import('vite').ModuleNode[] = []
        const seenModules = new Set<import('vite').ModuleNode>()
        const appliedOverlayPaths = new Set<string>()
        // Synthetic watcher events to dispatch after the per-file overlay
        // bookkeeping. Routing through `server.watcher.emit(...)` runs Vite's
        // native pipeline -- `pluginContainer.watchChange`, importGlob's
        // `hotUpdate({type:'create'|'delete'})` (which finds glob importers
        // like `Sidebar.tsx`), `updateModules` (proper invalidation +
        // importer walking), React-Refresh, and the right WS message
        // (`update` for HMR-able, `full-reload` otherwise). Without this,
        // the importGlob plugin never learns about a newly-added file and
        // Sidebar.tsx keeps its pre-add glob expansion until full relaunch.
        const watcherEvents: Array<{
          event: 'add' | 'change' | 'unlink'
          absPath: string
        }> = []
        let hasNewFileForGlobInvalidation = false

        for (const run of runs) {
          releaseRuns([run.runId])
          for (const file of run.files) {
            const absPath = file.absPath
            untrackPath(absPath)
            const diskReconciled = reconcileAppliedOverlayFileToDisk(file)
            if (file.deleted) {
              appliedOverlay.set(absPath, { content: DELETED_OVERLAY_MODULE, mtime: Date.now() })
            } else {
              appliedOverlay.set(absPath, { content: file.content ?? '', mtime: Date.now() })
            }
            if (diskReconciled) {
              appliedOverlayPaths.add(absPath)
            }
            appliedPaths += 1

            const mods = server.moduleGraph.getModulesByFile(absPath)
            const hadExistingModules = !!mods && mods.size > 0
            if (!hadExistingModules) {
              if (!file.deleted) hasNewFileForGlobInvalidation = true
            } else {
              for (const mod of mods) {
                if (seenModules.has(mod)) continue
                seenModules.add(mod)
                modulesToReload.push(mod)
              }
            }
            if (file.deleted) {
              watcherEvents.push({ event: 'unlink', absPath })
            } else {
              watcherEvents.push({
                event: hadExistingModules ? 'change' : 'add',
                absPath,
              })
            }
          }
        }

        // Belt-and-suspenders for the new-file glob case. The watcher emit
        // below should make this redundant in practice, but the synthetic
        // event chain is fire-and-forget and the renderer reload may race
        // it -- `invalidateAll` guarantees the next renderer fetch always
        // re-transforms glob importers fresh.
        if (hasNewFileForGlobInvalidation) {
          server.moduleGraph.invalidateAll()
        }

        // Invalidate the module graph synchronously so follow-up reloads see
        // fresh state. When the host is already performing a covered full
        // reload, do not call reloadModule: Vite may emit its own client
        // full-reload before the host's covered reloadIgnoringCache call.
        const invalidateSeen = new Set<import('vite').ModuleNode>()
        const invalidationTimestamp = Date.now()
        for (const mod of modulesToReload) {
          server.moduleGraph.invalidateModule(
            mod,
            invalidateSeen,
            invalidationTimestamp,
            true,
          )
        }

        // Dispatch synthetic watcher events so Vite's native pipeline runs
        // (importGlob hotUpdate, React-Refresh, proper WS messages). The
        // bypass set lets our own `handleHotUpdate` skip the pause gate for
        // these specific paths -- without it, concurrent runs that haven't
        // finalized yet would force a full-reload through the suppression
        // path. The set is also cleared on a 5s timeout as a leak guard in
        // case a listener never fires.
        const emittedKeys: string[] = []
        for (const { event, absPath } of watcherEvents) {
          const key = normalizeIdKey(absPath)
          recentlyEmittedSyntheticPaths.add(key)
          emittedKeys.push(key)
          try {
            server.watcher.emit(event, absPath)
          } catch (error) {
            recentlyEmittedSyntheticPaths.delete(key)
            console.warn(
              '[self-mod-hmr] watcher emit failed:',
              (error as Error).message,
            )
          }
        }
        if (emittedKeys.length > 0) {
          setTimeout(() => {
            for (const key of emittedKeys) {
              recentlyEmittedSyntheticPaths.delete(key)
            }
          }, 5_000).unref?.()
        }

        if (suppressClientFullReload) {
          for (const absPath of appliedOverlayPaths) {
            appliedOverlay.delete(absPath)
          }
          return {
            appliedPaths,
            reloadedModules,
            requiresClientFullReload: clientFullReloadRequestedDuringApply,
          }
        }

        let reloadFailed = false
        try {
          for (const mod of modulesToReload) {
            try {
              await server.reloadModule(mod)
              reloadedModules += 1
            } catch (error) {
              console.error(
                '[self-mod-hmr] Failed to reload module after apply:',
                (error as Error).message,
              )
              reloadFailed = true
              break
            }
          }

          if (forceClientFullReload || reloadFailed) {
            server.ws.send({ type: 'full-reload', path: '*' })
          }
          return {
            appliedPaths,
            reloadedModules,
            requiresClientFullReload:
              forceClientFullReload ||
              reloadFailed ||
              clientFullReloadRequestedDuringApply,
          }
        } finally {
          for (const absPath of appliedOverlayPaths) {
            appliedOverlay.delete(absPath)
          }
        }
        })

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith(SELF_MOD_HMR_ENDPOINT_BASE)) {
          return next()
        }

        const sendJson = (statusCode: number, payload: Record<string, unknown>) => {
          res.statusCode = statusCode
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }

        const urlPath = req.url.split('?')[0] ?? req.url
        if (!isAuthorizedSelfModRequest(req)) {
          sendJson(403, { ok: false, error: 'Forbidden' })
          return
        }

        if (req.method === 'GET' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/status`) {
          sendJson(200, {
            ok: true,
            paused: isClientUpdatePaused() || inFlightPaths.size > 0,
            pausedRuns: pausedRunIds.size,
            inFlightPaths: inFlightPaths.size,
            shellSnapshotPaths: shellSnapshotPaths.size,
            appliedOverlayPaths: appliedOverlay.size,
            suppressedHotUpdatePaths: suppressedHotUpdatePaths.size,
            suppressedClientMessages,
            shellMutationDepth,
          })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/pause-client-updates`) {
          const payload = (await readJsonBody(req)) as PausePayload
          const runId = typeof payload.runId === 'string' ? payload.runId : ''
          if (!runId) {
            sendJson(400, { ok: false, error: 'runId required' })
            return
          }
          pauseRun(runId)
          sendJson(200, {
            ok: true,
            paused: true,
            pausedRuns: pausedRunIds.size,
          })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/release-client-updates`) {
          const payload = (await readJsonBody(req)) as PausePayload
          const runIds = collectStringArray(payload.runIds)
          if (runIds.length === 0) {
            const runId = typeof payload.runId === 'string' ? payload.runId : ''
            if (runId) runIds.push(runId)
          }
          releaseRuns(runIds)
          sendJson(200, {
            ok: true,
            paused: isClientUpdatePaused(),
            pausedRuns: pausedRunIds.size,
            suppressedHotUpdatePaths: suppressedHotUpdatePaths.size,
          })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/track-paths`) {
          const payload = (await readJsonBody(req)) as TrackPayload
          const paths = collectStringArray(payload.paths)
          let tracked = 0
          for (const rel of paths) {
            const abs = resolveSelfModHmrAbsolutePath(rel)
            if (!abs) continue
            if (!isViteTrackableAbsolutePath(abs)) continue
            // A real run owner has now claimed this path. Keep it in-flight
            // until /apply or /untrack-paths, rather than releasing it with
            // the temporary shell snapshot set.
            shellSnapshotPaths.delete(abs)
            trackPath(abs)
            tracked += 1
          }
          sendJson(200, { ok: true, tracked, inFlightPaths: inFlightPaths.size })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/untrack-paths`) {
          const payload = (await readJsonBody(req)) as TrackPayload
          const paths = collectStringArray(payload.paths)
          let untracked = 0
          for (const rel of paths) {
            const abs = resolveSelfModHmrAbsolutePath(rel)
            if (!abs) continue
            if (!isViteTrackableAbsolutePath(abs)) continue
            untrackPath(abs)
            untracked += 1
          }
          sendJson(200, { ok: true, untracked, inFlightPaths: inFlightPaths.size })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/apply`) {
          const payload = (await readJsonBody(req)) as ApplyPayload
          const runs: Array<{
            runId: string
            files: Array<{ absPath: string; content: string | null; deleted: boolean }>
          }> = []
          if (Array.isArray(payload.runs)) {
            for (const run of payload.runs) {
              if (!run || typeof run !== 'object') continue
              const runId = typeof run.runId === 'string' ? run.runId : ''
              if (runId.length === 0) continue
              let files = collectApplyFiles(run)
              if (files.length === 0) {
                // Backward-compatible fallback for older workers. Newer
                // workers send file content captured at finalize time so a
                // cancelled overlapping run cannot leak its current disk
                // contents into a held run's apply.
                files = collectStringArray(run.paths)
                  .map((rel) => {
                    const absPath = resolveSelfModHmrAbsolutePath(rel)
                    return absPath && isViteTrackableAbsolutePath(absPath)
                      ? {
                          absPath,
                          content: readDiskOrEmpty(absPath),
                          deleted: false,
                        }
                      : null
                  })
                  .filter(
                    (file): file is {
                      absPath: string
                      content: string
                      deleted: boolean
                    } =>
                      file != null,
                  )
              }
              runs.push({ runId, files })
            }
          }
          const result = await applyBatch(runs, {
            suppressClientFullReload:
              payload.options?.suppressClientFullReload === true,
            forceClientFullReload:
              payload.options?.forceClientFullReload === true,
          })
          sendJson(200, {
            ok: true,
            runs: runs.length,
            appliedPaths: result.appliedPaths,
            reloadedModules: result.reloadedModules,
            requiresClientFullReload: result.requiresClientFullReload,
            inFlightPaths: inFlightPaths.size,
            appliedOverlayPaths: appliedOverlay.size,
          })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/discard`) {
          const payload = (await readJsonBody(req)) as TrackPayload
          const paths = collectStringArray(payload.paths)
          let discarded = 0
          for (const rel of paths) {
            const abs = resolveSelfModHmrAbsolutePath(rel)
            if (!abs) continue
            if (!isViteTrackableAbsolutePath(abs)) continue
            untrackPath(abs)
            shellSnapshotPaths.delete(abs)
            appliedOverlay.delete(abs)
            discarded += 1
          }
          sendJson(200, {
            ok: true,
            discarded,
            inFlightPaths: inFlightPaths.size,
            appliedOverlayPaths: appliedOverlay.size,
          })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/begin-shell-mutation`) {
          if (shellMutationDepth === 0) {
            for (const absPath of collectShellSnapshotFiles()) {
              trackShellSnapshotPath(absPath)
            }
          }
          shellMutationDepth += 1
          sendJson(200, { ok: true, shellMutationDepth })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/end-shell-mutation`) {
          shellMutationDepth = Math.max(0, shellMutationDepth - 1)
          let changedPaths: string[] = []
          if (shellMutationDepth === 0) {
            changedPaths = promoteSuppressedShellUpdatePaths()
            releaseShellSnapshotPaths()
          }
          sendJson(200, {
            ok: true,
            shellMutationDepth,
            inFlightPaths: inFlightPaths.size,
            shellSnapshotPaths: shellSnapshotPaths.size,
            changedPaths,
          })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/force-resume`) {
          const shouldReload =
            pausedRunIds.size > 0 ||
            inFlightPaths.size > 0 ||
            prePeriodSnapshot.size > 0 ||
            shellSnapshotPaths.size > 0 ||
            suppressedHotUpdatePaths.size > 0 ||
            shellMutationDepth > 0
          clearAllState()
          shellMutationDepth = 0
          if (shouldReload) {
            server.ws.send({ type: 'full-reload', path: '*' })
          }
          sendJson(200, { ok: true, paused: false, reloaded: shouldReload })
          return
        }

        sendJson(404, { ok: false, error: 'Not found' })
      })
    },
    async handleHotUpdate(ctx) {
      const key = normalizeIdKey(ctx.file)
      if (recentlyEmittedSyntheticPaths.has(key)) {
        // Self-mod's apply path just emitted this synthetic watcher event
        // to drive Vite's importGlob/HMR pipeline. Bypass the pause gate so
        // the standard hotUpdate hooks (importGlob in particular) actually
        // run. Consume the bypass entry so any later real disk write goes
        // back through the standard suppression path.
        recentlyEmittedSyntheticPaths.delete(key)
        if (appliedOverlay.has(key)) appliedOverlay.delete(key)
        return undefined
      }
      if (isClientUpdatePaused()) {
        // While any self-mod run is active, Stella owns when client updates
        // become visible. The worker releases finalized runs from inside the
        // morph cover via /apply, while still leaving other active runs
        // suppressed.
        suppressedHotUpdatePaths.add(key)
        return []
      }
      if (inFlightPaths.has(key)) {
        // Mid-run disk writes never propagate to the renderer; the apply
        // pipeline drives all visible HMR for tracked paths.
        return []
      }
      if (appliedOverlay.has(key)) {
        // A normal user/dev edit outside the self-mod apply pipeline should
        // take control again. Otherwise load() would keep serving the last
        // applied overlay content and make the file appear stuck.
        appliedOverlay.delete(key)
      }
      return undefined
    },
  }
}

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
    devServerUrl(),
    selfModHmrControl(),
    pdfWorkerAsset(),
  ],
  base: './',
  build: {
    outDir: 'dist',
    target: 'chrome134',
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        overlay: path.resolve(__dirname, 'overlay.html'),
        pet: path.resolve(__dirname, 'pet.html'),
      },
    },
  },
  server: {
    // Pin to IPv4 loopback and publish that exact address via the dev-url
    // plugin above. With the default (`localhost`), Node 17+'s verbatim DNS
    // order makes Vite bind IPv6-only on macOS, while Chromium may try IPv4
    // first and surface intermittent ERR_CONNECTION_REFUSED on cold start.
    host: '127.0.0.1',
    port: 57314,
    strictPort: false,
    forwardConsole: true,
    fs: {
      allow: [VITE_WORKSPACE_ROOT],
    },
    watch: {
      ignored: [
        `${STELLA_STATE_DIR.replace(/\\/g, '/')}/**`,
        normalizeWatchedFilePath(DEV_URL_FILE),
        normalizeWatchedFilePath(SELF_MOD_RUNTIME_RELOAD_STATE_FILE),
      ],
    },
  },
  resolve: {
    tsconfigPaths: true,
    alias: [
      { find: /^react$/, replacement: path.resolve(STELLA_REPO_ROOT, "node_modules/react/index.js") },
      { find: /^react\/jsx-runtime$/, replacement: path.resolve(STELLA_REPO_ROOT, "node_modules/react/jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.resolve(STELLA_REPO_ROOT, "node_modules/react/jsx-dev-runtime.js") },
      { find: /^react-dom$/, replacement: path.resolve(STELLA_REPO_ROOT, "node_modules/react-dom/index.js") },
      { find: /^react-dom\/client$/, replacement: path.resolve(STELLA_REPO_ROOT, "node_modules/react-dom/client.js") },
    ],
    dedupe: ["react", "react-dom"],
  },
})
