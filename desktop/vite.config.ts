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

export default defineConfig({
  plugins: [react(), tailwindcss(), devServerUrl()],
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
