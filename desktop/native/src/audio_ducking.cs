using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace StellaAudioDucking
{
    internal enum EDataFlow
    {
        eRender,
        eCapture,
        eAll,
        EDataFlow_enum_count,
    }

    internal enum ERole
    {
        eConsole,
        eMultimedia,
        eCommunications,
        ERole_enum_count,
    }

    [Flags]
    internal enum CLSCTX : uint
    {
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
        PS_DLL = 0x80000000,
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject
    {
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out object ppDevices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
        int GetDevice(string pwstrId, out IMMDevice ppDevice);
        int RegisterEndpointNotificationCallback(object pClient);
        int UnregisterEndpointNotificationCallback(object pClient);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    internal interface IMMDevice
    {
        int Activate(ref Guid iid, CLSCTX dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int OpenPropertyStore(int stgmAccess, out object ppProperties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        int GetState(out int pdwState);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    internal interface IAudioSessionManager2
    {
        int GetAudioSessionControl(IntPtr audioSessionGuid, uint streamFlags, out object sessionControl);
        int GetSimpleAudioVolume(IntPtr audioSessionGuid, uint streamFlags, out object audioVolume);
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
        int RegisterSessionNotification(object sessionNotification);
        int UnregisterSessionNotification(object sessionNotification);
        int RegisterDuckNotification(string sessionId, object duckNotification);
        int UnregisterDuckNotification(object duckNotification);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    internal interface IAudioSessionEnumerator
    {
        int GetCount(out int sessionCount);
        int GetSession(int sessionCount, out IAudioSessionControl session);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
    internal interface IAudioSessionControl
    {
        int GetState(out int pRetVal);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetGroupingParam(out Guid pRetVal);
        int SetGroupingParam(ref Guid groupingOverride, ref Guid eventContext);
        int RegisterAudioSessionNotification(object newNotifications);
        int UnregisterAudioSessionNotification(object newNotifications);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d")]
    internal interface IAudioSessionControl2
    {
        int GetState(out int pRetVal);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetGroupingParam(out Guid pRetVal);
        int SetGroupingParam(ref Guid groupingOverride, ref Guid eventContext);
        int RegisterAudioSessionNotification(object newNotifications);
        int UnregisterAudioSessionNotification(object newNotifications);
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int GetProcessId(out uint pRetVal);
        int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
    internal interface ISimpleAudioVolume
    {
        int SetMasterVolume(float level, ref Guid eventContext);
        int GetMasterVolume(out float level);
        int SetMute(bool mute, ref Guid eventContext);
        int GetMute(out bool muted);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    internal sealed class Request
    {
        public string Action { get; set; } = string.Empty;
        public float DuckFactor { get; set; } = 1.0f;
        public bool RecoverExcludedSessions { get; set; }
        public float RecoveryThreshold { get; set; }
        public float RecoveryFloor { get; set; } = 1.0f;
        public HashSet<int> ExcludePids { get; } = new HashSet<int>();
        public HashSet<string> ExcludeProcessPaths { get; } = new HashSet<string>(StringComparer.Ordinal);
        public HashSet<string> ExcludeProcessNames { get; } = new HashSet<string>(StringComparer.Ordinal);
        public List<SnapshotEntry> Snapshot { get; } = new List<SnapshotEntry>();
    }

    internal sealed class SnapshotEntry
    {
        public string SessionId { get; set; } = string.Empty;
        public string SessionInstanceId { get; set; } = string.Empty;
        public float Volume { get; set; }
    }

    internal sealed class SessionVolumeInfo
    {
        public uint ProcessId { get; set; }
        public string SessionId { get; set; } = string.Empty;
        public string SessionInstanceId { get; set; } = string.Empty;
        public float Volume { get; set; }
        public bool Muted { get; set; }
        public string ProcessName { get; set; } = string.Empty;
        public string ProcessPath { get; set; } = string.Empty;
    }

    internal static class HelperUtil
    {
        public static string NormalizeLower(string value)
        {
            return (value ?? string.Empty).Trim().ToLowerInvariant();
        }

        public static bool ParseBool(string value)
        {
            var normalized = value.Trim();
            return normalized == "1" || normalized.Equals("true", StringComparison.OrdinalIgnoreCase);
        }

        public static string DecodeBase64(string encoded)
        {
            if (string.IsNullOrWhiteSpace(encoded))
            {
                return string.Empty;
            }

            return Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
        }

        public static string EncodeBase64(string value)
        {
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? string.Empty));
        }
    }

    internal static class AudioSessionAccessor
    {
        public static List<SessionVolumeInfo> ListSessions()
        {
            var sessions = new List<SessionVolumeInfo>();
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out var device));

            object managerObject;
            var iid = typeof(IAudioSessionManager2).GUID;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX.INPROC_SERVER, IntPtr.Zero, out managerObject));
            var manager = (IAudioSessionManager2)managerObject;

            Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out var sessionEnumerator));
            Marshal.ThrowExceptionForHR(sessionEnumerator.GetCount(out var count));

            for (var index = 0; index < count; index++)
            {
                Marshal.ThrowExceptionForHR(sessionEnumerator.GetSession(index, out var control));
                var control2 = (IAudioSessionControl2)control;
                var volumeControl = (ISimpleAudioVolume)control;

                Marshal.ThrowExceptionForHR(control2.GetProcessId(out var processId));
                Marshal.ThrowExceptionForHR(control2.GetSessionIdentifier(out var sessionId));
                Marshal.ThrowExceptionForHR(control2.GetSessionInstanceIdentifier(out var sessionInstanceId));
                Marshal.ThrowExceptionForHR(volumeControl.GetMasterVolume(out var level));
                Marshal.ThrowExceptionForHR(volumeControl.GetMute(out var muted));

                var session = new SessionVolumeInfo
                {
                    ProcessId = processId,
                    SessionId = sessionId ?? string.Empty,
                    SessionInstanceId = sessionInstanceId ?? string.Empty,
                    Volume = level,
                    Muted = muted,
                };
                PopulateProcessMetadata(session, processId);
                sessions.Add(session);
            }

            return sessions;
        }

        public static void SetVolumeForSessionInstance(string sessionInstanceId, float level)
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out var device));

            object managerObject;
            var iid = typeof(IAudioSessionManager2).GUID;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX.INPROC_SERVER, IntPtr.Zero, out managerObject));
            var manager = (IAudioSessionManager2)managerObject;

            Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out var sessionEnumerator));
            Marshal.ThrowExceptionForHR(sessionEnumerator.GetCount(out var count));

            for (var index = 0; index < count; index++)
            {
                Marshal.ThrowExceptionForHR(sessionEnumerator.GetSession(index, out var control));
                var control2 = (IAudioSessionControl2)control;
                Marshal.ThrowExceptionForHR(control2.GetSessionInstanceIdentifier(out var currentInstanceId));
                if (!string.Equals(currentInstanceId ?? string.Empty, sessionInstanceId ?? string.Empty, StringComparison.Ordinal))
                {
                    continue;
                }

                var volumeControl = (ISimpleAudioVolume)control;
                var eventContext = Guid.Empty;
                Marshal.ThrowExceptionForHR(volumeControl.SetMasterVolume(level, ref eventContext));
            }
        }

        public static void SetVolumeForSession(string sessionId, float level)
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out var device));

            object managerObject;
            var iid = typeof(IAudioSessionManager2).GUID;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX.INPROC_SERVER, IntPtr.Zero, out managerObject));
            var manager = (IAudioSessionManager2)managerObject;

            Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out var sessionEnumerator));
            Marshal.ThrowExceptionForHR(sessionEnumerator.GetCount(out var count));

            for (var index = 0; index < count; index++)
            {
                Marshal.ThrowExceptionForHR(sessionEnumerator.GetSession(index, out var control));
                var control2 = (IAudioSessionControl2)control;
                Marshal.ThrowExceptionForHR(control2.GetSessionIdentifier(out var currentSessionId));
                if (!string.Equals(currentSessionId ?? string.Empty, sessionId ?? string.Empty, StringComparison.Ordinal))
                {
                    continue;
                }

                var volumeControl = (ISimpleAudioVolume)control;
                var eventContext = Guid.Empty;
                Marshal.ThrowExceptionForHR(volumeControl.SetMasterVolume(level, ref eventContext));
            }
        }

        private static void PopulateProcessMetadata(SessionVolumeInfo info, uint processId)
        {
            try
            {
                using (var process = Process.GetProcessById((int)processId))
                {
                    info.ProcessName = HelperUtil.NormalizeLower(process.ProcessName);
                    try
                    {
                        info.ProcessPath = HelperUtil.NormalizeLower(process.MainModule?.FileName ?? string.Empty);
                    }
                    catch
                    {
                        info.ProcessPath = string.Empty;
                    }
                }
            }
            catch
            {
                info.ProcessName = string.Empty;
                info.ProcessPath = string.Empty;
            }
        }
    }

    internal static class NativeProcessTree
    {
        private const uint TH32CS_SNAPPROCESS = 0x00000002;
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 processEntry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 processEntry);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static Dictionary<int, int> BuildParentMap()
        {
            var map = new Dictionary<int, int>();
            var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snapshot == InvalidHandleValue)
            {
                return map;
            }

            try
            {
                var entry = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
                if (!Process32FirstW(snapshot, ref entry))
                {
                    return map;
                }

                do
                {
                    map[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
                } while (Process32NextW(snapshot, ref entry));
            }
            finally
            {
                CloseHandle(snapshot);
            }

            return map;
        }

        public static bool IsDescendantProcess(int processId, HashSet<int> ancestorPids, Dictionary<int, int> parentMap)
        {
            var visited = new HashSet<int>();
            var current = processId;

            while (current > 0 && !visited.Contains(current))
            {
                if (ancestorPids.Contains(current))
                {
                    return true;
                }

                visited.Add(current);
                if (!parentMap.TryGetValue(current, out current))
                {
                    break;
                }
            }

            return false;
        }
    }

    internal static class Program
    {
        private static int Main()
        {
            try
            {
                var request = ParseRequest(Console.In.ReadToEnd());
                if (request.Action == "duck")
                {
                    return HandleDuck(request);
                }

                if (request.Action == "restore")
                {
                    return HandleRestore(request);
                }

                return WriteError("Missing or unsupported ACTION");
            }
            catch (Exception error)
            {
                return WriteError(error.Message);
            }
        }

        private static int HandleDuck(Request request)
        {
            var parentMap = NativeProcessTree.BuildParentMap();
            var snapshot = new List<SnapshotEntry>();

            foreach (var session in AudioSessionAccessor.ListSessions())
            {
                var sessionPid = (int)session.ProcessId;
                var excluded = IsExcludedSession(session, request, parentMap);

                if (excluded)
                {
                    if (
                        request.RecoverExcludedSessions &&
                        !session.Muted &&
                        session.Volume <= request.RecoveryThreshold)
                    {
                        SetSessionVolume(session, request.RecoveryFloor);
                    }
                    continue;
                }

                if (sessionPid <= 0 || session.Muted)
                {
                    continue;
                }

                if (string.IsNullOrEmpty(session.SessionId) && string.IsNullOrEmpty(session.SessionInstanceId))
                {
                    continue;
                }

                var duckedVolume = Math.Max(0.0f, Math.Min(1.0f, session.Volume * request.DuckFactor));
                SetSessionVolume(session, duckedVolume);
                snapshot.Add(new SnapshotEntry
                {
                    SessionId = session.SessionId,
                    SessionInstanceId = session.SessionInstanceId,
                    Volume = session.Volume,
                });
            }

            WriteSuccess(snapshot);
            return 0;
        }

        private static int HandleRestore(Request request)
        {
            foreach (var entry in request.Snapshot)
            {
                if (!string.IsNullOrEmpty(entry.SessionInstanceId))
                {
                    AudioSessionAccessor.SetVolumeForSessionInstance(entry.SessionInstanceId, entry.Volume);
                    continue;
                }

                if (!string.IsNullOrEmpty(entry.SessionId))
                {
                    AudioSessionAccessor.SetVolumeForSession(entry.SessionId, entry.Volume);
                }
            }

            WriteSuccess(Array.Empty<SnapshotEntry>());
            return 0;
        }

        private static bool IsExcludedSession(SessionVolumeInfo session, Request request, Dictionary<int, int> parentMap)
        {
            var sessionPid = (int)session.ProcessId;
            if (sessionPid <= 0)
            {
                return false;
            }

            if (request.ExcludePids.Contains(sessionPid))
            {
                return true;
            }

            if (NativeProcessTree.IsDescendantProcess(sessionPid, request.ExcludePids, parentMap))
            {
                return true;
            }

            if (!string.IsNullOrEmpty(session.ProcessPath) && request.ExcludeProcessPaths.Contains(session.ProcessPath))
            {
                return true;
            }

            if (string.IsNullOrEmpty(session.ProcessPath) && !string.IsNullOrEmpty(session.ProcessName) && request.ExcludeProcessNames.Contains(session.ProcessName))
            {
                return true;
            }

            return false;
        }

        private static void SetSessionVolume(SessionVolumeInfo session, float level)
        {
            if (!string.IsNullOrEmpty(session.SessionInstanceId))
            {
                AudioSessionAccessor.SetVolumeForSessionInstance(session.SessionInstanceId, level);
                return;
            }

            if (!string.IsNullOrEmpty(session.SessionId))
            {
                AudioSessionAccessor.SetVolumeForSession(session.SessionId, level);
            }
        }

        private static Request ParseRequest(string payload)
        {
            var request = new Request();
            var lines = payload.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
            foreach (var line in lines)
            {
                var parts = line.Split('\t');
                if (parts.Length == 0)
                {
                    continue;
                }

                switch (parts[0])
                {
                    case "ACTION":
                        request.Action = parts.Length >= 2 ? parts[1].Trim() : string.Empty;
                        break;
                    case "DUCK_FACTOR":
                        request.DuckFactor = parts.Length >= 2 ? float.Parse(parts[1], CultureInfo.InvariantCulture) : 1.0f;
                        break;
                    case "RECOVER_EXCLUDED_SESSIONS":
                        request.RecoverExcludedSessions = parts.Length >= 2 && ParseBool(parts[1]);
                        break;
                    case "RECOVERY_THRESHOLD":
                        request.RecoveryThreshold = parts.Length >= 2 ? float.Parse(parts[1], CultureInfo.InvariantCulture) : 0.0f;
                        break;
                    case "RECOVERY_FLOOR":
                        request.RecoveryFloor = parts.Length >= 2 ? float.Parse(parts[1], CultureInfo.InvariantCulture) : 1.0f;
                        break;
                    case "EXCLUDE_PID":
                        if (parts.Length >= 2 && int.TryParse(parts[1], out var pid) && pid > 0)
                        {
                            request.ExcludePids.Add(pid);
                        }
                        break;
                    case "EXCLUDE_PATH_B64":
                        if (parts.Length >= 2)
                        {
                        request.ExcludeProcessPaths.Add(HelperUtil.NormalizeLower(HelperUtil.DecodeBase64(parts[1])));
                        }
                        break;
                    case "EXCLUDE_NAME_B64":
                        if (parts.Length >= 2)
                        {
                        request.ExcludeProcessNames.Add(HelperUtil.NormalizeLower(HelperUtil.DecodeBase64(parts[1])));
                        }
                        break;
                    case "SNAPSHOT":
                        if (parts.Length >= 4)
                        {
                            request.Snapshot.Add(new SnapshotEntry
                            {
                                SessionId = DecodeBase64(parts[1]),
                                SessionInstanceId = DecodeBase64(parts[2]),
                                Volume = float.Parse(parts[3], CultureInfo.InvariantCulture),
                            });
                        }
                        break;
                }
            }

            return request;
        }

        private static bool ParseBool(string value)
        {
            var normalized = value.Trim();
            return normalized == "1" || normalized.Equals("true", StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeLower(string value)
        {
            return (value ?? string.Empty).Trim().ToLowerInvariant();
        }

        private static string DecodeBase64(string encoded)
        {
            if (string.IsNullOrWhiteSpace(encoded))
            {
                return string.Empty;
            }

            return Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
        }

        private static string EncodeBase64(string value)
        {
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? string.Empty));
        }

        private static void WriteSuccess(IEnumerable<SnapshotEntry> snapshot)
        {
            Console.Out.WriteLine("OK");
            foreach (var entry in snapshot)
            {
                Console.Out.WriteLine(
                    $"SNAPSHOT\t{EncodeBase64(entry.SessionId)}\t{EncodeBase64(entry.SessionInstanceId)}\t{entry.Volume.ToString("0.######", CultureInfo.InvariantCulture)}");
            }
        }

        private static int WriteError(string message)
        {
            Console.Out.WriteLine($"ERROR\t{message}");
            return 1;
        }
    }
}
