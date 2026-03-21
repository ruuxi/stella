import { bootstrapMainProcess } from './bootstrap.js'
import { emitStartupMetric } from './startup/profiler.js'

emitStartupMetric({
  metric: 'electron-main-entry',
  source: 'electron-main',
})

bootstrapMainProcess()
