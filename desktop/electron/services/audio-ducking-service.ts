import { app, BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type DuckSnapshotEntry = {
  sessionId: string
  sessionInstanceId: string
  volume: number
}

type PowerShellAudioDuckingRequest = {
  Action: 'duck' | 'restore'
  ExcludePids: number[]
  ExcludeProcessPaths: string[]
  ExcludeProcessNames: string[]
  Snapshot: DuckSnapshotEntry[]
  DuckFactor: number
  RecoverExcludedSessions: boolean
  RecoveryThreshold: number
  RecoveryFloor: number
}

const WINDOWS_DUCK_FACTOR = 0.25
const WINDOWS_AUDIO_DUCKING_SCRIPT_DIR_PREFIX = 'stella-audio-ducking-'
const WINDOWS_AUDIO_DUCKING_REQUEST_DIR_PREFIX = 'stella-audio-ducking-request-'

const WINDOWS_AUDIO_DUCKING_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$Action = [string]$request.Action
$DuckFactor = [double]$request.DuckFactor
$RecoverExcludedSessions = [bool]$request.RecoverExcludedSessions
$RecoveryThreshold = [double]$request.RecoveryThreshold
$RecoveryFloor = [double]$request.RecoveryFloor

Add-Type -Language CSharp @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;

namespace StellaAudioInterop {
  enum EDataFlow { eRender, eCapture, eAll, EDataFlow_enum_count }
  enum ERole { eConsole, eMultimedia, eCommunications, ERole_enum_count }

  [Flags]
  enum CLSCTX : uint {
    INPROC_SERVER = 0x1,
    INPROC_HANDLER = 0x2,
    LOCAL_SERVER = 0x4,
    INPROC_SERVER16 = 0x8,
    REMOTE_SERVER = 0x10,
    INPROC_HANDLER16 = 0x20,
    RESERVED1 = 0x40,
    RESERVED2 = 0x80,
    RESERVED3 = 0x100,
    RESERVED4 = 0x200,
    NO_CODE_DOWNLOAD = 0x400,
    RESERVED5 = 0x800,
    NO_CUSTOM_MARSHAL = 0x1000,
    ENABLE_CODE_DOWNLOAD = 0x2000,
    NO_FAILURE_LOG = 0x4000,
    DISABLE_AAA = 0x8000,
    ENABLE_AAA = 0x10000,
    FROM_DEFAULT_CONTEXT = 0x20000,
    ACTIVATE_32_BIT_SERVER = 0x40000,
    ACTIVATE_64_BIT_SERVER = 0x80000,
    ENABLE_CLOAKING = 0x100000,
    APPCONTAINER = 0x400000,
    ACTIVATE_AAA_AS_IU = 0x800000,
    PS_DLL = 0x80000000
  }

  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject {}

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out object ppDevices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
    int GetDevice(string pwstrId, out IMMDevice ppDevice);
    int RegisterEndpointNotificationCallback(object pClient);
    int UnregisterEndpointNotificationCallback(object pClient);
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  interface IMMDevice {
    int Activate(ref Guid iid, CLSCTX dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out object ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr AudioSessionGuid, uint StreamFlags, out object SessionControl);
    int GetSimpleAudioVolume(IntPtr AudioSessionGuid, uint StreamFlags, out object AudioVolume);
    int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
    int RegisterSessionNotification(object SessionNotification);
    int UnregisterSessionNotification(object SessionNotification);
    int RegisterDuckNotification(string sessionID, object duckNotification);
    int UnregisterDuckNotification(object duckNotification);
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
  interface IAudioSessionEnumerator {
    int GetCount(out int SessionCount);
    int GetSession(int SessionCount, out IAudioSessionControl Session);
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
  interface IAudioSessionControl {
    int GetState(out int pRetVal);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetGroupingParam(out Guid pRetVal);
    int SetGroupingParam(ref Guid Override, ref Guid EventContext);
    int RegisterAudioSessionNotification(object NewNotifications);
    int UnregisterAudioSessionNotification(object NewNotifications);
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d")]
  interface IAudioSessionControl2 {
    int GetState(out int pRetVal);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
    int GetGroupingParam(out Guid pRetVal);
    int SetGroupingParam(ref Guid Override, ref Guid EventContext);
    int RegisterAudioSessionNotification(object NewNotifications);
    int UnregisterAudioSessionNotification(object NewNotifications);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    int GetProcessId(out uint pRetVal);
    int IsSystemSoundsSession();
    int SetDuckingPreference(bool optOut);
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
  interface ISimpleAudioVolume {
    int SetMasterVolume(float fLevel, ref Guid EventContext);
    int GetMasterVolume(out float pfLevel);
    int SetMute(bool bMute, ref Guid EventContext);
    int GetMute(out bool pbMute);
  }

  public class SessionVolumeInfo {
    public uint ProcessId { get; set; }
    public string SessionId { get; set; }
    public string SessionInstanceId { get; set; }
    public string DisplayName { get; set; }
    public float Volume { get; set; }
    public bool Muted { get; set; }
    public string ProcessName { get; set; }
    public string ProcessPath { get; set; }
  }

  public static class AudioSessionAccessor {
    private static void PopulateProcessMetadata(SessionVolumeInfo info, uint processId) {
      try {
        using (var process = Process.GetProcessById((int)processId)) {
          info.ProcessName = process.ProcessName ?? string.Empty;
          try {
            info.ProcessPath = process.MainModule != null ? (process.MainModule.FileName ?? string.Empty) : string.Empty;
          } catch {
            info.ProcessPath = string.Empty;
          }
        }
      } catch {
        info.ProcessName = string.Empty;
        info.ProcessPath = string.Empty;
      }
    }

    public static List<SessionVolumeInfo> ListSessions() {
      var sessions = new List<SessionVolumeInfo>();

      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice device;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device));

      object managerObj;
      var iid = typeof(IAudioSessionManager2).GUID;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX.INPROC_SERVER, IntPtr.Zero, out managerObj));
      var manager = (IAudioSessionManager2)managerObj;

      IAudioSessionEnumerator sessionEnumerator;
      Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessionEnumerator));

      int count;
      Marshal.ThrowExceptionForHR(sessionEnumerator.GetCount(out count));
      for (int i = 0; i < count; i++) {
        IAudioSessionControl control;
        Marshal.ThrowExceptionForHR(sessionEnumerator.GetSession(i, out control));
        var control2 = (IAudioSessionControl2)control;
        uint pid;
        Marshal.ThrowExceptionForHR(control2.GetProcessId(out pid));
        string sessionId;
        Marshal.ThrowExceptionForHR(control2.GetSessionIdentifier(out sessionId));
        string sessionInstanceId;
        Marshal.ThrowExceptionForHR(control2.GetSessionInstanceIdentifier(out sessionInstanceId));
        string displayName;
        Marshal.ThrowExceptionForHR(control.GetDisplayName(out displayName));

        var volume = (ISimpleAudioVolume)control;
        float level;
        bool muted;
        Marshal.ThrowExceptionForHR(volume.GetMasterVolume(out level));
        Marshal.ThrowExceptionForHR(volume.GetMute(out muted));

        var info = new SessionVolumeInfo {
          ProcessId = pid,
          SessionId = sessionId ?? string.Empty,
          SessionInstanceId = sessionInstanceId ?? string.Empty,
          DisplayName = displayName ?? string.Empty,
          Volume = level,
          Muted = muted
        };
        PopulateProcessMetadata(info, pid);
        sessions.Add(info);
      }

      return sessions;
    }

    public static void SetVolumeForSessionInstance(string sessionInstanceId, float level) {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice device;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device));

      object managerObj;
      var iid = typeof(IAudioSessionManager2).GUID;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX.INPROC_SERVER, IntPtr.Zero, out managerObj));
      var manager = (IAudioSessionManager2)managerObj;

      IAudioSessionEnumerator sessionEnumerator;
      Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessionEnumerator));

      int count;
      Marshal.ThrowExceptionForHR(sessionEnumerator.GetCount(out count));
      var context = Guid.Empty;
      for (int i = 0; i < count; i++) {
        IAudioSessionControl control;
        Marshal.ThrowExceptionForHR(sessionEnumerator.GetSession(i, out control));
        var control2 = (IAudioSessionControl2)control;
        string currentSessionInstanceId;
        Marshal.ThrowExceptionForHR(control2.GetSessionInstanceIdentifier(out currentSessionInstanceId));
        if (!string.Equals(currentSessionInstanceId ?? string.Empty, sessionInstanceId ?? string.Empty, StringComparison.Ordinal)) continue;

        var volume = (ISimpleAudioVolume)control;
        Marshal.ThrowExceptionForHR(volume.SetMasterVolume(level, ref context));
      }
    }

    public static void SetVolumeForSession(string sessionId, float level) {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice device;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device));

      object managerObj;
      var iid = typeof(IAudioSessionManager2).GUID;
      Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX.INPROC_SERVER, IntPtr.Zero, out managerObj));
      var manager = (IAudioSessionManager2)managerObj;

      IAudioSessionEnumerator sessionEnumerator;
      Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessionEnumerator));

      int count;
      Marshal.ThrowExceptionForHR(sessionEnumerator.GetCount(out count));
      var context = Guid.Empty;
      for (int i = 0; i < count; i++) {
        IAudioSessionControl control;
        Marshal.ThrowExceptionForHR(sessionEnumerator.GetSession(i, out control));
        var control2 = (IAudioSessionControl2)control;
        string currentSessionId;
        Marshal.ThrowExceptionForHR(control2.GetSessionIdentifier(out currentSessionId));
        if (!string.Equals(currentSessionId ?? string.Empty, sessionId ?? string.Empty, StringComparison.Ordinal)) continue;

        var volume = (ISimpleAudioVolume)control;
        Marshal.ThrowExceptionForHR(volume.SetMasterVolume(level, ref context));
      }
    }
  }
}
"@

$excludePids = @()
if ($null -ne $request.ExcludePids) {
  $excludePids = @($request.ExcludePids | ForEach-Object { [int]$_ })
}
$processParentMap = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $processParentMap[[int]$_.ProcessId] = [int]$_.ParentProcessId
}
function Test-IsDescendantProcess {
  param(
    [int]$ProcessId,
    [int[]]$AncestorPids,
    [hashtable]$ParentMap
  )

  $visited = New-Object 'System.Collections.Generic.HashSet[int]'
  $current = $ProcessId
  while ($current -gt 0 -and -not $visited.Contains($current)) {
    if ($AncestorPids -contains $current) {
      return $true
    }
    [void]$visited.Add($current)
    if (-not $ParentMap.ContainsKey($current)) {
      break
    }
    $current = [int]$ParentMap[$current]
  }

  return $false
}
$excludeProcessPaths = @()
if ($null -ne $request.ExcludeProcessPaths) {
  $excludeProcessPaths = @(
    ($request.ExcludeProcessPaths) |
      ForEach-Object { [string]$_ } |
      Where-Object { $_ -and $_.Trim().Length -gt 0 } |
      ForEach-Object { $_.Trim().ToLowerInvariant() }
  )
}
$excludeProcessNames = @()
if ($null -ne $request.ExcludeProcessNames) {
  $excludeProcessNames = @(
    ($request.ExcludeProcessNames) |
      ForEach-Object { [string]$_ } |
      Where-Object { $_ -and $_.Trim().Length -gt 0 } |
      ForEach-Object { $_.Trim().ToLowerInvariant() }
  )
}

function Test-IsExcludedSession {
  param(
    [object]$Session,
    [int[]]$ExcludePids,
    [hashtable]$ParentMap,
    [string[]]$ExcludeProcessPaths,
    [string[]]$ExcludeProcessNames
  )

  $sessionPid = [int]$Session.ProcessId
  if ($sessionPid -le 0) { return $false }
  if ($ExcludePids -contains $sessionPid) { return $true }
  if (Test-IsDescendantProcess -ProcessId $sessionPid -AncestorPids $ExcludePids -ParentMap $ParentMap) {
    return $true
  }

  $sessionProcessPath = [string]$Session.ProcessPath
  if ($sessionProcessPath -and $ExcludeProcessPaths -contains $sessionProcessPath.Trim().ToLowerInvariant()) {
    return $true
  }

  $sessionProcessName = [string]$Session.ProcessName
  if (
    (-not $sessionProcessPath -or -not $sessionProcessPath.Trim()) -and
    $sessionProcessName -and
    $ExcludeProcessNames -contains $sessionProcessName.Trim().ToLowerInvariant()
  ) {
    return $true
  }

  return $false
}

function Set-SessionVolume {
  param(
    [object]$Session,
    [double]$Level
  )

  $sessionInstanceId = [string]$Session.SessionInstanceId
  if ($sessionInstanceId -and $sessionInstanceId.Trim()) {
    [StellaAudioInterop.AudioSessionAccessor]::SetVolumeForSessionInstance(
      $sessionInstanceId.Trim(),
      [single]$Level
    )
    return $true
  }

  $sessionId = [string]$Session.SessionId
  if ($sessionId -and $sessionId.Trim()) {
    [StellaAudioInterop.AudioSessionAccessor]::SetVolumeForSession(
      $sessionId.Trim(),
      [single]$Level
    )
    return $true
  }

  return $false
}

if ($Action -eq 'duck') {
  $sessions = [StellaAudioInterop.AudioSessionAccessor]::ListSessions()
  $snapshot = @()
  foreach ($session in $sessions) {
    $isExcluded = Test-IsExcludedSession -Session $session -ExcludePids $excludePids -ParentMap $processParentMap -ExcludeProcessPaths $excludeProcessPaths -ExcludeProcessNames $excludeProcessNames

    if ($isExcluded) {
      if (
        $RecoverExcludedSessions -and
        -not $session.Muted -and
        ([double]$session.Volume) -le $RecoveryThreshold
      ) {
        [void](Set-SessionVolume -Session $session -Level $RecoveryFloor)
      }
      continue
    }
    if ($session.Muted) { continue }

    $originalVolume = [double]$session.Volume
    $duckedVolume = [Math]::Max(0.0, [Math]::Min(1.0, $originalVolume * $DuckFactor))
    if (-not (Set-SessionVolume -Session $session -Level $duckedVolume)) {
      continue
    }
    $snapshot += [pscustomobject]@{
      sessionId = [string]$session.SessionId
      sessionInstanceId = [string]$session.SessionInstanceId
      volume = $originalVolume
    }
  }

  ConvertTo-Json -InputObject @($snapshot) -Compress
  exit 0
}

$snapshot = @()
if ($null -ne $request.Snapshot) {
  $snapshot = @($request.Snapshot)
}
foreach ($entry in $snapshot) {
  if ($null -eq $entry.volume) { continue }
  $restoreVolume = [double](@($entry.volume)[0])
  $restoreSessionInstanceId = [string](@($entry.sessionInstanceId)[0])
  if ($restoreSessionInstanceId -and $restoreSessionInstanceId.Trim()) {
    [StellaAudioInterop.AudioSessionAccessor]::SetVolumeForSessionInstance(
      $restoreSessionInstanceId.Trim(),
      [single]$restoreVolume
    )
    continue
  }

  $restoreSessionId = [string](@($entry.sessionId)[0])
  if ($restoreSessionId -and $restoreSessionId.Trim()) {
    [StellaAudioInterop.AudioSessionAccessor]::SetVolumeForSession(
      $restoreSessionId.Trim(),
      [single]$restoreVolume
    )
  }
}

'[]'
`

let windowsAudioDuckingScriptPathPromise: Promise<string> | null = null

const ensureWindowsAudioDuckingScriptPath = async (): Promise<string> => {
  if (!windowsAudioDuckingScriptPathPromise) {
    windowsAudioDuckingScriptPathPromise = (async () => {
      const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), WINDOWS_AUDIO_DUCKING_SCRIPT_DIR_PREFIX))
      const scriptPath = path.join(scriptDir, 'audio-ducking.ps1')
      await fs.writeFile(scriptPath, WINDOWS_AUDIO_DUCKING_SCRIPT, 'utf8')
      return scriptPath
    })().catch((error) => {
      windowsAudioDuckingScriptPathPromise = null
      throw error
    })
  }

  return windowsAudioDuckingScriptPathPromise
}

const execPowerShell = async (request: PowerShellAudioDuckingRequest): Promise<string> => {
  const scriptPath = await ensureWindowsAudioDuckingScriptPath()
  const requestDir = await fs.mkdtemp(path.join(os.tmpdir(), WINDOWS_AUDIO_DUCKING_REQUEST_DIR_PREFIX))
  const requestPath = path.join(requestDir, 'audio-ducking-request.json')

  try {
    await fs.writeFile(requestPath, JSON.stringify(request), 'utf8')

    return await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-RequestPath', requestPath],
        { windowsHide: true, maxBuffer: 1024 * 1024 * 4 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr?.trim() || error.message))
            return
          }
          resolve(stdout.trim())
        },
      )
    })
  } finally {
    await fs.rm(requestDir, { recursive: true, force: true }).catch(() => {})
  }
}

const uniquePids = (values: Array<number | null | undefined>): number[] =>
  [...new Set(values.filter((value): value is number => Number.isInteger(value) && (value ?? 0) > 0))]

export class AudioDuckingService {
  private duckSnapshot: DuckSnapshotEntry[] = []
  private active = false
  private inFlight: Promise<void> | null = null
  private selfRecoveryAttempted = false

  constructor(
    private readonly getWindows: () => BrowserWindow[],
  ) {}

  async setAssistantSpeaking(active: boolean): Promise<void> {
    if (this.inFlight) {
      await this.inFlight.catch(() => {})
    }
    this.inFlight = active ? this.activate() : this.deactivate()
    try {
      await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async activate(): Promise<void> {
    if (this.active) return
    this.active = true

    if (process.platform !== 'win32') {
      return
    }

    try {
      const shouldRecoverSelfSessions = !this.selfRecoveryAttempted
      this.selfRecoveryAttempted = true
      const stdout = await execPowerShell({
        Action: 'duck',
        ExcludePids: this.getExcludedProcessIds(),
        ExcludeProcessPaths: this.getExcludedProcessPaths(),
        ExcludeProcessNames: this.getExcludedProcessNames(),
        RecoverExcludedSessions: shouldRecoverSelfSessions,
        RecoveryThreshold: WINDOWS_DUCK_FACTOR + 0.01,
        RecoveryFloor: 1.0,
        Snapshot: [],
        DuckFactor: WINDOWS_DUCK_FACTOR,
      })
      this.duckSnapshot = stdout ? JSON.parse(stdout) as DuckSnapshotEntry[] : []
    } catch (error) {
      this.active = false
      this.duckSnapshot = []
      console.debug('[audio-ducking] Failed to duck external audio:', (error as Error).message)
    }
  }

  private async deactivate(): Promise<void> {
    if (!this.active && this.duckSnapshot.length === 0) return
    this.active = false

    if (process.platform !== 'win32') {
      return
    }
    if (this.duckSnapshot.length === 0) {
      return
    }

    const snapshot = this.duckSnapshot
    this.duckSnapshot = []

    try {
      await execPowerShell({
        Action: 'restore',
        ExcludePids: [],
        ExcludeProcessPaths: [],
        ExcludeProcessNames: [],
        RecoverExcludedSessions: false,
        RecoveryThreshold: 0,
        RecoveryFloor: 1.0,
        Snapshot: snapshot,
        DuckFactor: WINDOWS_DUCK_FACTOR,
      })
    } catch (error) {
      console.debug('[audio-ducking] Failed to restore external audio:', (error as Error).message)
    }
  }

  private getExcludedProcessIds(): number[] {
    return uniquePids([
      process.pid,
      ...app.getAppMetrics().map((metric) => metric.pid),
      ...this.getWindows().flatMap((window) => {
        if (window.isDestroyed()) return []
        return [window.webContents.getOSProcessId()]
      }),
    ])
  }

  private getExcludedProcessPaths(): string[] {
    return [process.execPath]
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  }

  private getExcludedProcessNames(): string[] {
    const executableName = path.basename(process.execPath, path.extname(process.execPath))
    return [executableName]
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  }
}
