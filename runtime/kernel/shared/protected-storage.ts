import { createRequire } from 'module'
import { spawnSync } from 'node:child_process'

type SafeStorageLike = {
  isEncryptionAvailable: () => boolean
  encryptString: (plaintext: string) => Buffer
  decryptString: (ciphertext: Buffer) => string
}

const require = createRequire(import.meta.url)
const PROTECTED_PREFIX = 'stella-protected'
const LAUNCHER_PROTECTED_PREFIX = 'stella-launcher-keychain'
const DEV_PLAINTEXT_PREFIX = 'stella-dev-plaintext'
const DEV_INSECURE_STORAGE_ENV = 'STELLA_DEV_INSECURE_PROTECTED_STORAGE'
const LAUNCHER_STORAGE_BIN_ENV = 'STELLA_LAUNCHER_PROTECTED_STORAGE_BIN'

let safeStorageCache: SafeStorageLike | null | undefined

const useDevPlaintextStorage = () =>
  process.env[DEV_INSECURE_STORAGE_ENV] === '1'

const getLauncherProtectedStorageBin = () => {
  const value = process.env[LAUNCHER_STORAGE_BIN_ENV]?.trim()
  return value || null
}

const useLauncherProtectedStorage = () =>
  getLauncherProtectedStorageBin() !== null

const launcherPrefixForScope = (scope: string) =>
  `${LAUNCHER_PROTECTED_PREFIX}:${scope}:v1:`

const callLauncherProtectedStorage = (
  operation: 'protect' | 'unprotect' | 'delete',
  scope: string,
  value: string,
): string | null => {
  const bin = getLauncherProtectedStorageBin()
  if (!bin) return null

  const result = spawnSync(bin, ['--stella-protected-storage'], {
    input: JSON.stringify({ operation, scope, value }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) {
    throw result.error
  }

  let parsed: { ok?: boolean; value?: unknown; error?: unknown }
  try {
    parsed = JSON.parse(result.stdout || '{}') as {
      ok?: boolean
      value?: unknown
      error?: unknown
    }
  } catch {
    throw new Error('Launcher protected storage returned invalid JSON.')
  }

  if (!parsed.ok) {
    throw new Error(
      typeof parsed.error === 'string'
        ? parsed.error
        : 'Launcher protected storage failed.',
    )
  }
  return typeof parsed.value === 'string' ? parsed.value : null
}

const getSafeStorage = (): SafeStorageLike => {
  if (safeStorageCache) {
    return safeStorageCache
  }
  if (safeStorageCache === null) {
    throw new Error('Protected storage is unavailable.')
  }
  if (!process.versions.electron) {
    safeStorageCache = null
    throw new Error('Protected storage requires Electron runtime.')
  }

  const electronModule = require('electron') as
    | { safeStorage?: SafeStorageLike }
    | string
  const safeStorage =
    typeof electronModule === 'string' ? undefined : electronModule.safeStorage

  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    safeStorageCache = null
    throw new Error('OS protected storage is unavailable.')
  }

  safeStorageCache = safeStorage
  return safeStorage
}

const prefixForScope = (scope: string) => `${PROTECTED_PREFIX}:${scope}:v1:`
const devPrefixForScope = (scope: string) =>
  `${DEV_PLAINTEXT_PREFIX}:${scope}:v1:`

export const protectValue = (scope: string, plaintext: string): string => {
  const launcherValue = callLauncherProtectedStorage(
    'protect',
    scope,
    plaintext,
  )
  if (launcherValue) {
    return launcherValue
  }

  if (useDevPlaintextStorage()) {
    return `${devPrefixForScope(scope)}${Buffer.from(plaintext, 'utf8').toString('base64url')}`
  }

  const safeStorage = getSafeStorage()
  const encrypted = safeStorage.encryptString(plaintext)
  return `${prefixForScope(scope)}${encrypted.toString('base64url')}`
}

export const unprotectValue = (scope: string, value: string): string | null => {
  if (typeof value !== 'string') {
    return null
  }

  const devPrefix = devPrefixForScope(scope)
  if (value.startsWith(devPrefix)) {
    const encoded = value.slice(devPrefix.length)
    if (!encoded) {
      return null
    }
    try {
      return Buffer.from(encoded, 'base64url').toString('utf8')
    } catch {
      return null
    }
  }

  if (value.startsWith(launcherPrefixForScope(scope))) {
    return callLauncherProtectedStorage('unprotect', scope, value)
  }

  const prefix = prefixForScope(scope)
  if (!value.startsWith(prefix)) {
    return null
  }
  if (useLauncherProtectedStorage()) {
    return null
  }

  const encoded = value.slice(prefix.length)
  if (!encoded) {
    return null
  }

  try {
    const safeStorage = getSafeStorage()
    return safeStorage.decryptString(Buffer.from(encoded, 'base64url'))
  } catch {
    return null
  }
}

export const deleteProtectedValue = (scope: string, value: string): void => {
  if (typeof value !== 'string') {
    return
  }

  if (value.startsWith(launcherPrefixForScope(scope))) {
    callLauncherProtectedStorage('delete', scope, value)
  }
}
