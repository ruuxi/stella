import { execFile } from 'child_process'
import { runNativeHelper } from './native-helper.js'
import type { RecentApp } from '../src/shared/contracts/home.js'

// Dedicated home-suggestion helper. Lives in `home_apps.swift` (separate
// from `desktop_automation` so the agent-facing tool stays untouched by
// renderer-UI concerns: MRU sort, AX title fallback, regular-apps-only
// scope, per-element AX timeouts, diagnostics in warnings).
const HELPER_NAME = 'home_apps'
const RECENT_APPS_CACHE_MS = 2_500

type RawListedApp = {
  name?: string
  bundleId?: string | null
  pid?: number
  isActive?: boolean
  windowTitle?: string
  iconDataUrl?: string | null
}

type RawListAppsPayload = {
  ok?: boolean
  apps?: RawListedApp[]
  warnings?: string[]
}

type RecentAppsCacheEntry = {
  expiresAt: number
  value: RecentApp[] | null
}

const recentAppsCache = new Map<string, RecentAppsCacheEntry>()
const recentAppsInFlight = new Map<string, Promise<RecentApp[] | null>>()

/**
 * Apps that are part of the OS chrome / always-on infra. Filtered before
 * showing in the renderer because they carry no user signal as a chip.
 */
const NOISE_NAMES = new Set([
  // macOS — UI chrome
  'finder',
  'dock',
  'systemuiserver',
  'controlcenter',
  'control center',
  'notificationcenter',
  'notification center',
  'spotlight',
  'windowserver',
  'screen sharing',
  'wallpaper',
  'loginwindow',
  'coreservicesuiagent',
  'sidecar',
  'siri',
  'crashpad',
  // macOS — TCC / privacy / auth prompts that occasionally register as
  // .regular activation-policy apps. None of them are something a user
  // would deliberately treat as "context for Stella."
  'universalaccessauthwarn',
  'universal access auth',
  'tccd',
  'authorizationhost',
  'securityagent',
  'storedownloadd',
  'screenshot',
  // Windows
  'explorer',
  'searchhost',
  'searchapp',
  'startmenuexperiencehost',
  'shellexperiencehost',
  'lockapp',
  'applicationframehost',
  'runtimebroker',
  'textinputhost',
  'sihost',
  'ctfmon',
  'dwm',
  'fontdrvhost',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'smss',
  'lsass',
  'svchost',
  'taskhostw',
  'systemsettings',
  'gamebar',
  'gamebarpresencewriter',
  'msedgewebview2',
  'widgets',
])

/**
 * macOS bundle-id substrings for Apple system services that periodically
 * present themselves as regular apps (auth prompts, install dialogs, etc.).
 * Substring match is intentional — Apple keeps adding new variants
 * (`com.apple.*.UniversalAccessAuthWarn`,
 *  `com.apple.AccessibilityVisualsAgent`, etc.) and a substring net
 * catches them all.
 */
const NOISE_BUNDLE_ID_SUBSTRINGS = [
  'universalaccessauth',
  'tccd',
  'authorizationhost',
  'securityagent',
  'screensharing',
  'screencaptureui',
  'systemuiserver',
  'controlcenter',
  'notificationcenter',
  'spotlight',
  'windowserver',
  'loginwindow',
  'coreservicesuiagent',
]

const STELLA_BUNDLE_ID_PREFIXES = ['com.stella', 'ai.stella', 'org.stella']
const STELLA_PROCESS_NAMES = new Set(['stella', 'stella helper'])

const isStellaApp = (
  rawName: string | undefined,
  bundleId: string | undefined | null,
): boolean => {
  const lowerBundle = bundleId?.toLowerCase()
  if (lowerBundle) {
    for (const prefix of STELLA_BUNDLE_ID_PREFIXES) {
      if (lowerBundle.startsWith(prefix)) return true
    }
  }
  return STELLA_PROCESS_NAMES.has((rawName ?? '').toLowerCase().trim())
}

const isNoiseName = (name: string): boolean =>
  NOISE_NAMES.has(name.toLowerCase().trim())

const isNoiseBundleId = (bundleId: string | undefined | null): boolean => {
  if (!bundleId) return false
  const lower = bundleId.toLowerCase()
  for (const needle of NOISE_BUNDLE_ID_SUBSTRINGS) {
    if (lower.includes(needle)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// macOS implementation — wraps the bundled `home_apps list` helper.
// home_apps already filters to regular activation-policy apps (so the AX
// title-fallback loop stays bounded). It returns apps in MRU order with
// each app's topmost-window title attached.
// ---------------------------------------------------------------------------

const listRecentAppsMac = async (
  limit: number,
): Promise<RecentApp[] | null> => {
  // Generous timeout because the helper's AX-title fallback can stall for
  // ~0.5s per pid when an app is unresponsive. The UI polls infrequently
  // enough that 8s is invisible.
  const stdout = await runNativeHelper(HELPER_NAME, ['list'], {
    timeout: 8_000,
    maxBuffer: 4 * 1024 * 1024,
    onError: (error) => {
      console.warn('[home] home_apps list (mac) failed', error.message)
    },
  })

  if (!stdout) return null

  let parsed: RawListAppsPayload
  try {
    parsed = JSON.parse(stdout) as RawListAppsPayload
  } catch (error) {
    console.warn('[home] home_apps list (mac) parse failed', error)
    return null
  }

  if (parsed.ok === false || !Array.isArray(parsed.apps)) {
    return null
  }

  const cleaned: RecentApp[] = []
  const seenPids = new Set<number>()

  for (const raw of parsed.apps) {
    if (typeof raw.name !== 'string' || typeof raw.pid !== 'number') continue
    if (isStellaApp(raw.name, raw.bundleId ?? null)) continue
    if (isNoiseName(raw.name)) continue
    if (isNoiseBundleId(raw.bundleId ?? null)) continue
    if (seenPids.has(raw.pid)) continue
    seenPids.add(raw.pid)

    const windowTitle =
      typeof raw.windowTitle === 'string' ? raw.windowTitle.trim() : ''
    const iconDataUrl =
      typeof raw.iconDataUrl === 'string' &&
      raw.iconDataUrl.startsWith('data:image/')
        ? raw.iconDataUrl
        : undefined
    cleaned.push({
      name: raw.name,
      bundleId: raw.bundleId ?? undefined,
      pid: raw.pid,
      isActive: Boolean(raw.isActive),
      windowTitle: windowTitle || undefined,
      iconDataUrl,
    })
  }

  return cleaned.slice(0, Math.max(0, limit))
}

// ---------------------------------------------------------------------------
// Windows implementation — PowerShell snapshot of windowed processes.
// ---------------------------------------------------------------------------

type WinProcess = {
  ProcessName?: string
  Id?: number
  MainWindowTitle?: string
}

const execAsync = (
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(typeof stdout === 'string' ? stdout : null)
      },
    )
  })

const cleanWindowsName = (name: string): string =>
  name.replace(/\.exe$/i, '').trim()

const listRecentAppsWindows = async (
  limit: number,
): Promise<RecentApp[] | null> => {
  // PowerShell: enumerate windowed processes, then mark the current foreground
  // window as active via P/Invoke (GetForegroundWindow).
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Name 'StellaFW' -Namespace 'Win32' -MemberDefinition @'
[DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")]
public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int lpdwProcessId);
'@
$fgPid = 0
$null = [Win32.StellaFW]::GetWindowThreadProcessId([Win32.StellaFW]::GetForegroundWindow(), [ref]$fgPid)
$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object Id, ProcessName, MainWindowTitle, @{Name='IsActive';Expression={$_.Id -eq $fgPid}}
$procs | ConvertTo-Json -Compress
`.trim()
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64')

  const stdout = await execAsync(
    'powershell.exe',
    ['-NoProfile', '-EncodedCommand', encoded],
    3_000,
  )
  if (!stdout) return null

  const trimmed = stdout.trim()
  if (!trimmed || trimmed === 'null') return null

  let parsed: WinProcess[]
  try {
    const json = JSON.parse(trimmed.startsWith('[') ? trimmed : `[${trimmed}]`)
    parsed = Array.isArray(json) ? (json as WinProcess[]) : []
  } catch (error) {
    console.warn('[home] list-apps (win) parse failed', error)
    return null
  }

  const cleaned: RecentApp[] = []
  const seenPids = new Set<number>()
  // Foreground window first, then by name (case-insensitive) for stable order.
  parsed.sort((a, b) => {
    const aActive = a as { IsActive?: boolean }
    const bActive = b as { IsActive?: boolean }
    if (aActive.IsActive !== bActive.IsActive) {
      return aActive.IsActive ? -1 : 1
    }
    const aName = (a.ProcessName ?? '').toLowerCase()
    const bName = (b.ProcessName ?? '').toLowerCase()
    return aName.localeCompare(bName)
  })

  for (const raw of parsed) {
    const rawName = raw.ProcessName?.trim()
    const pid = typeof raw.Id === 'number' ? raw.Id : NaN
    if (!rawName || !Number.isFinite(pid)) continue
    if (isStellaApp(rawName, null)) continue
    if (isNoiseName(rawName)) continue
    if (seenPids.has(pid)) continue
    seenPids.add(pid)

    const windowTitle = raw.MainWindowTitle?.trim() ?? ''
    cleaned.push({
      name: cleanWindowsName(rawName),
      pid,
      isActive: Boolean((raw as { IsActive?: boolean }).IsActive),
      windowTitle: windowTitle || undefined,
    })
  }

  return cleaned.slice(0, Math.max(0, limit))
}

// ---------------------------------------------------------------------------

/**
 * Snapshot of running user-facing apps. macOS via the bundled Swift helper;
 * Windows via PowerShell. The frontmost app is marked `isActive: true`.
 *
 * Returns `null` when the platform is unsupported or the underlying snapshot
 * call failed (treat as "no signal" — render nothing).
 */
export const listRecentApps = async (
  limit = 6,
): Promise<RecentApp[] | null> => {
  const normalizedLimit = Math.max(0, Math.floor(limit))
  const cacheKey = `${process.platform}:${normalizedLimit}`
  const now = Date.now()
  const cached = recentAppsCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const inFlight = recentAppsInFlight.get(cacheKey)
  if (inFlight) {
    return await inFlight
  }

  const promise = (async () => {
    if (process.platform === 'darwin')
      return await listRecentAppsMac(normalizedLimit)
    if (process.platform === 'win32')
      return await listRecentAppsWindows(normalizedLimit)
    return null
  })()

  recentAppsInFlight.set(cacheKey, promise)
  try {
    const value = await promise
    recentAppsCache.set(cacheKey, {
      expiresAt: Date.now() + RECENT_APPS_CACHE_MS,
      value,
    })
    return value
  } finally {
    recentAppsInFlight.delete(cacheKey)
  }
}
