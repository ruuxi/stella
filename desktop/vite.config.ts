import fs from "fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

const DEV_URL_FILE = path.resolve(__dirname, '.vite-dev-url')

/** Writes the resolved dev server URL to .vite-dev-url so Electron can discover it. */
function devServerUrl(): Plugin {
  return {
    name: 'dev-server-url',
    configureServer(server) {
      try { fs.unlinkSync(DEV_URL_FILE) } catch {}
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

/**
 * Serves workspace panel .tsx files through Vite's transform pipeline.
 * Path containment: only files inside <projectRoot>/workspace/panels/ are served.
 * Filename validation: must match PANEL_FILE_PATTERN.
 */
function workspacePanelServer(): Plugin {
  return {
    name: 'workspace-panel-server',
    configureServer(server) {
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

        // Resolve and contain path within workspace/panels/
        const panelsDir = path.resolve(server.config.root, 'workspace', 'panels')
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
          // Transform the TSX file through Vite's pipeline
          const result = await server.transformRequest(urlPath)
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

export default defineConfig({
  plugins: [react(), tailwindcss(), devServerUrl(), workspacePanelServer()],
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        radial: path.resolve(__dirname, 'radial.html'),
      },
    },
  },
  server: {
    port: 5714,
    strictPort: false,
    watch: {
      ignored: ['**/workspace/**'],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
