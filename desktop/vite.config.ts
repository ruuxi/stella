import fs from "fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, searchForWorkspaceRoot, type ModuleNode, type Plugin } from "vite"

const DEV_URL_FILE = path.resolve(__dirname, '.vite-dev-url')
const SELF_MOD_HMR_STATE_FILE = path.resolve(__dirname, '.stella-hmr-state.json')
const SELF_MOD_HMR_ENDPOINT_BASE = '/__stella/self-mod/hmr'
const SELF_MOD_HMR_STALE_MS = 30_000
const STELLA_WORKSPACE_PANELS_DIR = path.resolve(
  __dirname,
  'workspace',
  'panels',
)
const VITE_WORKSPACE_ROOT = searchForWorkspaceRoot(__dirname)
const PACKAGE_MANIFEST_BASENAMES = new Set([
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
])

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
          fs.writeFileSync(DEV_URL_FILE, `http://localhost:${addr.port}`)
        }
      })
    },
  }
}

const PANEL_FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.tsx$/
const toViteFsPath = (filePath: string) => `/@fs/${filePath.replace(/\\/g, '/')}`

/**
 * Serves workspace panel .tsx files through Vite's transform pipeline.
 * Path containment: only files inside desktop/workspace/panels/ are served.
 * Filename validation: must match PANEL_FILE_PATTERN.
 */
function workspacePanelServer(): Plugin {
  return {
    name: 'workspace-panel-server',
    configureServer(server) {
      try {
        fs.mkdirSync(STELLA_WORKSPACE_PANELS_DIR, { recursive: true })
      } catch (error) {
        console.warn('[workspace-panel-server] Failed to create runtime panels directory:', error)
      }

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/workspace/panels/')) return next()

        // Strip query string (e.g. ?t=timestamp for cache-busting)
        const urlPath = req.url.split('?')[0]!
        const filename = path.posix.basename(urlPath)

        // Validate filename pattern
        if (!PANEL_FILE_PATTERN.test(filename)) {
          res.statusCode = 403
          res.end('Forbidden: invalid panel filename')
          return
        }

        // Resolve and contain path within desktop/workspace/panels/
        const panelsDir = STELLA_WORKSPACE_PANELS_DIR
        const resolved = path.resolve(panelsDir, filename)
        const relative = path.relative(panelsDir, resolved)

        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          res.statusCode = 403
          res.end('Forbidden: path outside panels directory')
          return
        }

        // Check file exists
        if (!fs.existsSync(resolved)) {
          res.statusCode = 404
          res.end('Panel not found')
          return
        }

        try {
          // Transform the runtime TSX file through Vite's pipeline.
          const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
          const result = await server.transformRequest(`${toViteFsPath(resolved)}${query}`)
          if (!result) {
            res.statusCode = 500
            res.end('Transform failed')
            return
          }

          res.setHeader('Content-Type', 'application/javascript')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(result.code)
        } catch (err) {
          console.error('[workspace-panel-server] Transform error:', err)
          res.statusCode = 500
          res.end('Transform error')
        }
      })
    },
  }
}

type PersistedSelfModHmrState = {
  paused?: boolean
  requiresFullReload?: boolean
  updatedAtMs?: number
}

const readPersistedSelfModHmrState = (): PersistedSelfModHmrState => {
  try {
    const raw = fs.readFileSync(SELF_MOD_HMR_STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as PersistedSelfModHmrState
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    return parsed
  } catch {
    return {}
  }
}

const writePersistedSelfModHmrState = (state: PersistedSelfModHmrState) => {
  fs.writeFileSync(
    SELF_MOD_HMR_STATE_FILE,
    JSON.stringify(
      {
        paused: Boolean(state.paused),
        requiresFullReload: Boolean(state.requiresFullReload),
        updatedAtMs: Date.now(),
      },
      null,
      2,
    ),
  )
}

const isDependencyManifestFile = (filePath: string) =>
  PACKAGE_MANIFEST_BASENAMES.has(path.basename(filePath))

type SelfModHmrFlushMode = 'none' | 'module-reload' | 'full-reload'

export const getSelfModHmrFlushMode = (args: {
  queuedModuleCount: number
  queuedFileCount: number
  requiresFullReload: boolean
}): SelfModHmrFlushMode => {
  if (args.requiresFullReload) {
    return 'full-reload'
  }

  if (args.queuedModuleCount > 0) {
    return 'module-reload'
  }

  if (args.queuedFileCount > 0) {
    return 'full-reload'
  }

  return 'none'
}

/**
 * Pauses visible HMR during agent self-mod turns, then resumes updates in one flush.
 * During pause we suppress client propagation (`handleHotUpdate -> []`) while Vite
 * continues to transform and report compile errors in the background.
 */
function selfModHmrControl(): Plugin {
  let paused = false
  let requiresFullReload = false
  const queuedModules = new Set<ModuleNode>()
  const queuedFiles = new Set<string>()

  const queueFile = (filePath: string, root: string) => {
    const rel = path.relative(root, filePath).replace(/\\/g, '/')
    queuedFiles.add(rel.startsWith('..') ? filePath.replace(/\\/g, '/') : rel)
  }

  const clearQueue = () => {
    queuedModules.clear()
    queuedFiles.clear()
    requiresFullReload = false
  }

  return {
    name: 'stella-self-mod-hmr-control',
    enforce: 'post',
    configureServer(server) {
      const persisted = readPersistedSelfModHmrState()
      const isFresh =
        typeof persisted.updatedAtMs === 'number'
        && Date.now() - persisted.updatedAtMs < SELF_MOD_HMR_STALE_MS
      paused = Boolean(persisted.paused) && isFresh
      requiresFullReload = Boolean(persisted.requiresFullReload)
      writePersistedSelfModHmrState({ paused, requiresFullReload })

      const invalidateQueuedModules = () => {
        if (queuedModules.size === 0) {
          return;
        }

        const seen = new Set<ModuleNode>();
        const timestamp = Date.now();
        for (const mod of queuedModules) {
          server.moduleGraph.invalidateModule(mod, seen, timestamp, true);
        }
      };

      const flushQueuedUpdates = async () => {
        const flushMode = getSelfModHmrFlushMode({
          queuedModuleCount: queuedModules.size,
          queuedFileCount: queuedFiles.size,
          requiresFullReload,
        })

        if (flushMode === 'none') {
          return
        }

        if (flushMode === 'full-reload') {
          invalidateQueuedModules()
          server.ws.send({ type: 'full-reload', path: '*' })
          clearQueue()
          writePersistedSelfModHmrState({ paused, requiresFullReload })
          return
        }

        let reloadFailed = false
        for (const mod of queuedModules) {
          try {
            await server.reloadModule(mod)
          } catch (error) {
            console.error('[self-mod-hmr] Failed to reload queued module:', error)
            reloadFailed = true
            break
          }
        }

        if (reloadFailed) {
          invalidateQueuedModules()
          server.ws.send({ type: 'full-reload', path: '*' })
        }

        clearQueue()
        writePersistedSelfModHmrState({ paused, requiresFullReload })
      }

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

        if (req.method === 'GET' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/status`) {
          sendJson(200, {
            ok: true,
            paused,
            queuedFiles: queuedFiles.size,
            requiresFullReload,
          })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/pause`) {
          paused = true
          writePersistedSelfModHmrState({ paused, requiresFullReload })
          sendJson(200, { ok: true, paused })
          return
        }

        if (req.method === 'POST' && urlPath === `${SELF_MOD_HMR_ENDPOINT_BASE}/resume`) {
          paused = false
          await flushQueuedUpdates()
          writePersistedSelfModHmrState({ paused, requiresFullReload })
          sendJson(200, { ok: true, paused })
          return
        }

        sendJson(404, { ok: false, error: 'Not found' })
      })
    },
    async handleHotUpdate(ctx) {
      if (!paused) {
        return
      }

      if (isDependencyManifestFile(ctx.file) || ctx.modules.length === 0) {
        requiresFullReload = true
      }

      queueFile(ctx.file, ctx.server.config.root)
      for (const mod of ctx.modules) {
        queuedModules.add(mod)
      }

      writePersistedSelfModHmrState({ paused, requiresFullReload })
      return []
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devServerUrl(), workspacePanelServer(), selfModHmrControl()],
  base: './',
  build: {
    outDir: 'dist',
    target: 'chrome134',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        overlay: path.resolve(__dirname, 'overlay.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('shiki') || id.includes('@shikijs')) return 'vendor-shiki'
            if (id.includes('recharts') || id.includes('d3-') || id.includes('victory')) return 'vendor-charts'
            if (id.includes('@radix-ui')) return 'vendor-radix'
            if (id.includes('@google/genai')) return 'vendor-genai'
            if (id.includes('react-dom')) return 'vendor-react'
          }
        },
      },
    },
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      'lucide-react',
      'zod',
      'date-fns',
    ],
    exclude: [
      '@convex-dev/better-auth',
      '@convex-dev/better-auth/react',
      'convex',
    ],
  },
  server: {
    port: 5714,
    strictPort: false,
    forwardConsole: true,
    fs: {
      allow: [VITE_WORKSPACE_ROOT, STELLA_WORKSPACE_PANELS_DIR],
    },
  },
  resolve: {
    tsconfigPaths: true,
    alias: [
      { find: /^react$/, replacement: path.resolve(__dirname, "./node_modules/react/index.js") },
      { find: /^react\/jsx-runtime$/, replacement: path.resolve(__dirname, "./node_modules/react/jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.resolve(__dirname, "./node_modules/react/jsx-dev-runtime.js") },
      { find: /^react-dom$/, replacement: path.resolve(__dirname, "./node_modules/react-dom/index.js") },
      { find: /^react-dom\/client$/, replacement: path.resolve(__dirname, "./node_modules/react-dom/client.js") },
    ],
    dedupe: ["react", "react-dom"],
  },
})
