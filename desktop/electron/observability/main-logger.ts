import { app } from 'electron'
import {
  getFileLogger,
  initFileLogger,
  installGlobalErrorLogging,
  type FileLogger,
} from '../../../runtime/observability/file-logger.js'

/**
 * Electron main-process diagnostics wiring.
 *
 * Routes uncaught errors / crashes and process lifecycle (app + child
 * process crashes) into the shared local log files under
 * `~/.stella/logs/<rootHash>/`. Metadata only — no window content, URLs
 * with query strings, or message data ever reaches here.
 */

let registered = false

const safe = (fn: () => string): string => {
  try {
    return fn()
  } catch {
    return ''
  }
}

export const initMainProcessLogging = (stellaAppDir: string): FileLogger => {
  const logger = initFileLogger(stellaAppDir, 'main')
  if (registered) return logger
  registered = true

  installGlobalErrorLogging(logger)
  logger.process('main.starting', {
    pid: process.pid,
    version: safe(() => app.getVersion()),
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  })

  app.on('ready', () => {
    logger.process('main.ready', {
      pid: process.pid,
      // Time-to-ready since process launch — a cheap boot-regression signal.
      startupMs: Math.round(process.uptime() * 1000),
      // Where Electron writes native minidumps for GPU/renderer crashes,
      // so a crash in the error log can be cross-referenced with a dump.
      crashDumps: safe(() => app.getPath('crashDumps')),
    })
  })
  app.on('quit', (_event, exitCode) => {
    logger.process('main.quit', { pid: process.pid, exitCode })
  })

  // GPU / utility / pepper / renderer subprocess crashes.
  app.on('child-process-gone', (_event, details) => {
    logger.error('main.child-process-gone', {
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name,
    })
  })

  app.on('render-process-gone', (_event, _webContents, details) => {
    logger.error('main.render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })

  return logger
}

export const getMainLogger = (): FileLogger | null => getFileLogger()
