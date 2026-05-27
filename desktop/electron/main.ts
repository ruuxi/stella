import { bootstrapMainProcess } from './bootstrap.js'
// Side-effect import so esbuild bundles the morph-test scratch file into
// the main process bundle. Lets the morph-test app trigger a real
// Electron-binary restart by editing one file the dev-electron watcher
// already cares about. Safe to remove if the morph-test app is uninstalled.
import './_morph_test_scratch.js'

bootstrapMainProcess()
