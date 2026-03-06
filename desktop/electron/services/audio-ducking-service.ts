import { app, BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'

type DuckSnapshotEntry = {
  pid: number
  volume: number
}

const WINDOWS_DUCK_FACTOR = 0.25

const WINDOWS_AUDIO_DUCKING_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

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

        var volume = (ISimpleAudioVolume)control;
        float level;
        bool muted;
        Marshal.ThrowExceptionForHR(volume.GetMasterVolume(out level));
        Marshal.ThrowExceptionForHR(volume.GetMute(out muted));

        var info = new SessionVolumeInfo {
          ProcessId = pid,
          Volume = level,
          Muted = muted
        };
        PopulateProcessMetadata(info, pid);
        sessions.Add(info);
      }

      return sessions;
    }

    public static void SetVolume(uint processId, float level) {
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
        uint pid;
        Marshal.ThrowExceptionForHR(control2.GetProcessId(out pid));
        if (pid != processId) continue;

        var volume = (ISimpleAudioVolume)control;
        Marshal.ThrowExceptionForHR(volume.SetMasterVolume(level, ref context));
      }
    }
  }
}
"@

$excludePids = @()
if ($ExcludePidsJson) {
  $excludePids = @((ConvertFrom-Json -InputObject $ExcludePidsJson) | ForEach-Object { [int]$_ })
}
$excludeProcessPaths = @()
if ($ExcludeProcessPathsJson) {
  $excludeProcessPaths = @(
    (ConvertFrom-Json -InputObject $ExcludeProcessPathsJson) |
      ForEach-Object { [string]$_ } |
      Where-Object { $_ -and $_.Trim().Length -gt 0 } |
      ForEach-Object { $_.Trim().ToLowerInvariant() }
  )
}
$excludeProcessNames = @()
if ($ExcludeProcessNamesJson) {
  $excludeProcessNames = @(
    (ConvertFrom-Json -InputObject $ExcludeProcessNamesJson) |
      ForEach-Object { [string]$_ } |
      Where-Object { $_ -and $_.Trim().Length -gt 0 } |
      ForEach-Object { $_.Trim().ToLowerInvariant() }
  )
}

if ($Action -eq 'duck') {
  $sessions = [StellaAudioInterop.AudioSessionAccessor]::ListSessions()
  $snapshot = @()
  foreach ($session in $sessions) {
    $sessionPid = [int]$session.ProcessId
    if ($sessionPid -le 0) { continue }
    if ($excludePids -contains $sessionPid) { continue }
    if ($session.Muted) { continue }
    $sessionProcessPath = [string]$session.ProcessPath
    $sessionProcessName = [string]$session.ProcessName
    if ($sessionProcessPath -and $excludeProcessPaths -contains $sessionProcessPath.Trim().ToLowerInvariant()) {
      continue
    }
    if (
      (-not $sessionProcessPath -or -not $sessionProcessPath.Trim()) -and
      $sessionProcessName -and
      $excludeProcessNames -contains $sessionProcessName.Trim().ToLowerInvariant()
    ) {
      continue
    }

    $originalVolume = [double]$session.Volume
    $duckedVolume = [Math]::Max(0.0, [Math]::Min(1.0, $originalVolume * $DuckFactor))
    [StellaAudioInterop.AudioSessionAccessor]::SetVolume([uint32]$sessionPid, [single]$duckedVolume)
    $snapshot += [pscustomobject]@{
      pid = $sessionPid
      volume = $originalVolume
    }
  }

  ConvertTo-Json -InputObject @($snapshot) -Compress
  exit 0
}

$snapshot = @()
if ($SnapshotJson) {
  $snapshot = @(ConvertFrom-Json -InputObject $SnapshotJson)
}
foreach ($entry in $snapshot) {
  if ($null -eq $entry.pid -or $null -eq $entry.volume) { continue }
  $restorePid = [int](@($entry.pid)[0])
  $restoreVolume = [double](@($entry.volume)[0])
  [StellaAudioInterop.AudioSessionAccessor]::SetVolume([uint32]$restorePid, [single]$restoreVolume)
}

'[]'
`

const toPowerShellSingleQuoted = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`

const execPowerShell = (command: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
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

const uniquePids = (values: Array<number | null | undefined>): number[] =>
  [...new Set(values.filter((value): value is number => Number.isInteger(value) && (value ?? 0) > 0))]

export class AudioDuckingService {
  private duckSnapshot: DuckSnapshotEntry[] = []
  private active = false
  private inFlight: Promise<void> | null = null

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
      const stdout = await execPowerShell([
        `$Action = 'duck'`,
        `$ExcludePidsJson = ${toPowerShellSingleQuoted(JSON.stringify(this.getExcludedProcessIds()))}`,
        `$ExcludeProcessPathsJson = ${toPowerShellSingleQuoted(JSON.stringify(this.getExcludedProcessPaths()))}`,
        `$ExcludeProcessNamesJson = ${toPowerShellSingleQuoted(JSON.stringify(this.getExcludedProcessNames()))}`,
        `$SnapshotJson = '[]'`,
        `$DuckFactor = ${String(WINDOWS_DUCK_FACTOR)}`,
        WINDOWS_AUDIO_DUCKING_SCRIPT,
      ].join("\n"))
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
      await execPowerShell([
        `$Action = 'restore'`,
        `$ExcludePidsJson = '[]'`,
        `$ExcludeProcessPathsJson = '[]'`,
        `$ExcludeProcessNamesJson = '[]'`,
        `$SnapshotJson = ${toPowerShellSingleQuoted(JSON.stringify(snapshot))}`,
        `$DuckFactor = ${String(WINDOWS_DUCK_FACTOR)}`,
        WINDOWS_AUDIO_DUCKING_SCRIPT,
      ].join("\n"))
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
