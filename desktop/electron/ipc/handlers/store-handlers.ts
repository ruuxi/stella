import { promises as fs } from 'fs'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import os from 'os'
import path from 'path'
import {
  handleInstallCanvas,
  handleInstallSkill,
  handleInstallTheme,
  handleUninstallPackage,
} from '../../pi-runtime/extensions/stella/tools-store.js'
import * as bridgeManager from '../../system/bridge-manager.js'

const STORE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/
const STORE_TOKEN_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/
const STORE_PACKAGE_TYPES = new Set(['skill', 'theme', 'canvas', 'mod'] as const)
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i
const NPM_PACKAGE_VERSION_PATTERN = /^[a-z0-9*^~<>=|.+-]+$/i
const MAX_STORE_NAME_CHARS = 120
const MAX_STORE_MARKDOWN_CHARS = 250_000
const MAX_STORE_SOURCE_CHARS = 250_000
const MAX_STORE_DEPENDENCIES = 64
const MAX_THEME_TOKENS = 256

type StoreHandlersOptions = {
  assertPrivilegedSender: (event: IpcMainEvent | IpcMainInvokeEvent, channel: string) => boolean
  ensurePrivilegedActionApproval: (
    action: string,
    message: string,
    detail: string,
    event?: IpcMainEvent | IpcMainInvokeEvent,
  ) => Promise<boolean>
}

const asTrimmedString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const sanitizeStoreId = (value: unknown, fieldName: string) => {
  const normalized = asTrimmedString(value)
  if (!STORE_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${fieldName}.`)
  }
  return normalized
}

const sanitizeStoreName = (value: unknown, fieldName: string) => {
  const normalized = asTrimmedString(value)
  if (!normalized || normalized.length > MAX_STORE_NAME_CHARS) {
    throw new Error(`Invalid ${fieldName}.`)
  }
  return normalized
}

const sanitizeStoreTokenList = (
  value: unknown,
  fieldName: string,
  maxItems: number,
) => {
  if (!Array.isArray(value)) {
    return [] as string[]
  }
  if (value.length > maxItems) {
    throw new Error(`Too many values for ${fieldName}.`)
  }
  const result: string[] = []
  for (const item of value) {
    const normalized = asTrimmedString(item)
    if (!STORE_TOKEN_PATTERN.test(normalized)) {
      throw new Error(`Invalid ${fieldName}.`)
    }
    result.push(normalized)
  }
  return result
}

const sanitizeThemePalette = (value: unknown, fieldName: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName} palette.`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_THEME_TOKENS) {
    throw new Error(`Invalid ${fieldName} palette.`)
  }
  const palette: Record<string, string> = {}
  for (const [key, rawValue] of entries) {
    const normalizedKey = key.trim()
    const normalizedValue = asTrimmedString(rawValue)
    if (!STORE_TOKEN_PATTERN.test(normalizedKey) || !normalizedValue || normalizedValue.length > 200) {
      throw new Error(`Invalid ${fieldName} palette.`)
    }
    palette[normalizedKey] = normalizedValue
  }
  return palette
}

const sanitizeCanvasDependencies = (value: unknown) => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid canvas dependencies.')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_STORE_DEPENDENCIES) {
    throw new Error('Too many canvas dependencies.')
  }
  const dependencies: Record<string, string> = {}
  for (const [pkgName, rawVersion] of entries) {
    const version = asTrimmedString(rawVersion)
    if (!NPM_PACKAGE_NAME_PATTERN.test(pkgName) || !NPM_PACKAGE_VERSION_PATTERN.test(version)) {
      throw new Error('Invalid canvas dependencies.')
    }
    dependencies[pkgName] = version
  }
  return dependencies
}

const sanitizeCanvasSource = (value: unknown) => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error('Invalid canvas source.')
  }
  if (value.length > MAX_STORE_SOURCE_CHARS) {
    throw new Error('Canvas source is too large.')
  }
  return value
}

const sanitizeStoreType = (value: unknown) => {
  if (typeof value !== 'string' || !STORE_PACKAGE_TYPES.has(value as 'skill' | 'theme' | 'canvas' | 'mod')) {
    throw new Error('Invalid package type.')
  }
  return value as 'skill' | 'theme' | 'canvas' | 'mod'
}

const sanitizeSkillInstallPayload = (payload: {
  packageId: string
  skillId: string
  name: string
  markdown: string
  agentTypes?: string[]
  tags?: string[]
}) => {
  const markdown = asTrimmedString(payload.markdown)
  if (!markdown) {
    throw new Error('Skill install requires markdown.')
  }
  if (markdown.length > MAX_STORE_MARKDOWN_CHARS) {
    throw new Error('Skill markdown is too large.')
  }
  const agentTypes = sanitizeStoreTokenList(payload.agentTypes, 'agentTypes', 16)
  return {
    packageId: sanitizeStoreId(payload.packageId, 'packageId'),
    skillId: sanitizeStoreId(payload.skillId, 'skillId'),
    name: sanitizeStoreName(payload.name, 'name'),
    markdown,
    agentTypes: agentTypes.length > 0 ? agentTypes : ['general'],
    tags: sanitizeStoreTokenList(payload.tags, 'tags', 32),
  }
}

const sanitizeThemeInstallPayload = (payload: {
  packageId: string
  themeId: string
  name: string
  light: Record<string, string>
  dark: Record<string, string>
}) => ({
  packageId: sanitizeStoreId(payload.packageId, 'packageId'),
  themeId: sanitizeStoreId(payload.themeId, 'themeId'),
  name: sanitizeStoreName(payload.name, 'name'),
  light: sanitizeThemePalette(payload.light, 'light'),
  dark: sanitizeThemePalette(payload.dark, 'dark'),
})

const sanitizeCanvasInstallPayload = (payload: {
  packageId: string
  workspaceId?: string
  name: string
  dependencies?: Record<string, string>
  source?: string
}) => ({
  packageId: sanitizeStoreId(payload.packageId, 'packageId'),
  workspaceId: payload.workspaceId === undefined ? undefined : sanitizeStoreId(payload.workspaceId, 'workspaceId'),
  name: sanitizeStoreName(payload.name, 'name'),
  dependencies: sanitizeCanvasDependencies(payload.dependencies),
  source: sanitizeCanvasSource(payload.source),
})

const sanitizeStoreUninstallPayload = (payload: {
  packageId: string
  type: string
  localId: string
}) => ({
  packageId: sanitizeStoreId(payload.packageId, 'packageId'),
  type: sanitizeStoreType(payload.type),
  localId: sanitizeStoreId(payload.localId, 'localId'),
})

const unwrapStoreResult = (result: { result?: unknown; error?: string }) => {
  if (result.error) {
    throw new Error(result.error)
  }
  return result.result ?? {}
}

export const registerStoreHandlers = (options: StoreHandlersOptions) => {
  ipcMain.handle('store:installSkill', async (event, payload: {
    packageId: string; skillId: string; name: string; markdown: string; agentTypes?: string[]; tags?: string[]
  }) => {
    if (!options.assertPrivilegedSender(event, 'store:installSkill')) {
      throw new Error('Blocked untrusted store install request.')
    }
    const safePayload = sanitizeSkillInstallPayload(payload)
    const approved = await options.ensurePrivilegedActionApproval(
      'store.install.skill',
      'Allow Stella to install a skill package?',
      'Skills write files under ~/.stella/skills. This keeps Stella autonomous while preventing hidden renderer abuse.',
      event,
    )
    if (!approved) {
      throw new Error('Skill install denied.')
    }
    return unwrapStoreResult(await handleInstallSkill(safePayload))
  })

  ipcMain.handle('store:installTheme', async (event, payload: {
    packageId: string; themeId: string; name: string; light: Record<string, string>; dark: Record<string, string>
  }) => {
    if (!options.assertPrivilegedSender(event, 'store:installTheme')) {
      throw new Error('Blocked untrusted store theme install request.')
    }
    const safePayload = sanitizeThemeInstallPayload(payload)
    const approved = await options.ensurePrivilegedActionApproval(
      'store.install.theme',
      'Allow Stella to install a theme package?',
      'Themes write files under ~/.stella/themes.',
      event,
    )
    if (!approved) {
      throw new Error('Theme install denied.')
    }
    return unwrapStoreResult(await handleInstallTheme(safePayload))
  })

  ipcMain.handle('store:installCanvas', async (event, payload: {
    packageId: string
    workspaceId?: string
    name: string
    dependencies?: Record<string, string>
    source?: string
  }) => {
    if (!options.assertPrivilegedSender(event, 'store:installCanvas')) {
      throw new Error('Blocked untrusted store canvas install request.')
    }
    const safePayload = sanitizeCanvasInstallPayload(payload)
    const approved = await options.ensurePrivilegedActionApproval(
      'store.install.canvas',
      'Allow Stella to install a canvas app?',
      'Canvas installs can write local app code and dependencies under ~/.stella/apps.',
      event,
    )
    if (!approved) {
      throw new Error('Canvas install denied.')
    }
    return unwrapStoreResult(await handleInstallCanvas(safePayload))
  })

  ipcMain.handle('store:uninstall', async (event, payload: {
    packageId: string; type: string; localId: string
  }) => {
    if (!options.assertPrivilegedSender(event, 'store:uninstall')) {
      throw new Error('Blocked untrusted store uninstall request.')
    }
    const safePayload = sanitizeStoreUninstallPayload(payload)
    const approved = await options.ensurePrivilegedActionApproval(
      'store.uninstall',
      'Allow Stella to uninstall local package files?',
      'Uninstall may remove files under ~/.stella.',
      event,
    )
    if (!approved) {
      throw new Error('Package uninstall denied.')
    }
    return unwrapStoreResult(await handleUninstallPackage(safePayload))
  })

  ipcMain.handle('bridge:deploy', async (event, payload: {
    provider: string; code: string; env: Record<string, string>; dependencies: string
  }) => {
    if (!options.assertPrivilegedSender(event, 'bridge:deploy')) {
      throw new Error('Blocked untrusted bridge deploy request.')
    }
    const approved = await options.ensurePrivilegedActionApproval(
      'bridge.deploy',
      'Allow Stella to deploy local bridge code?',
      'Bridge deploy writes executable code under ~/.stella/bridges and may install dependencies.',
      event,
    )
    if (!approved) {
      throw new Error('Bridge deploy denied.')
    }
    return bridgeManager.deploy(payload)
  })

  ipcMain.handle('bridge:start', async (event, payload: { provider: string }) => {
    if (!options.assertPrivilegedSender(event, 'bridge:start')) {
      throw new Error('Blocked untrusted bridge start request.')
    }
    const approved = await options.ensurePrivilegedActionApproval(
      'bridge.start',
      'Allow Stella to start local bridge processes?',
      'Starting a bridge runs local Node.js code with configured bridge environment variables.',
      event,
    )
    if (!approved) {
      throw new Error('Bridge start denied.')
    }
    return bridgeManager.start(payload.provider)
  })

  ipcMain.handle('bridge:stop', async (event, payload: { provider: string }) => {
    if (!options.assertPrivilegedSender(event, 'bridge:stop')) {
      throw new Error('Blocked untrusted bridge stop request.')
    }
    return bridgeManager.stop(payload.provider)
  })

  ipcMain.handle('bridge:status', async (event, payload: { provider: string }) => {
    if (!options.assertPrivilegedSender(event, 'bridge:status')) {
      throw new Error('Blocked untrusted bridge status request.')
    }
    return { running: bridgeManager.isRunning(payload.provider) }
  })

  ipcMain.handle('theme:listInstalled', async () => {
    const themesDir = path.join(os.homedir(), '.stella', 'themes')
    try {
      const files = await fs.readdir(themesDir)
      const themes = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = await fs.readFile(path.join(themesDir, file), 'utf-8')
          const theme = JSON.parse(raw)
          if (theme.id && theme.name && theme.light && theme.dark) {
            themes.push(theme)
          }
        } catch {
          // skip invalid theme files
        }
      }
      return themes
    } catch {
      return []
    }
  })
}
