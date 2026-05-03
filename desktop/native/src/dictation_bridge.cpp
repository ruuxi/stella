// dictation_bridge.exe - Native Windows helpers for dictation paste/routing.
//
// Usage:
//   dictation_bridge.exe probe
//   dictation_bridge.exe paste <text>
//   dictation_bridge.exe mute-output
//   dictation_bridge.exe restore-output <previousVolume> [previousMuted]
//
// probe output:
//   {"ok":true,"frontmostBundleId":"chrome.exe","frontmostPid":123,"focusedEditable":true}
//
// Compile (MSVC):
//   cl /O2 /EHsc dictation_bridge.cpp /link ole32.lib oleaut32.lib uuid.lib user32.lib /OUT:dictation_bridge.exe
// Compile (mingw-w64):
//   x86_64-w64-mingw32-g++ -O2 -static dictation_bridge.cpp
//       -o dictation_bridge.exe -lole32 -loleaut32 -luuid -luser32

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <initguid.h>
#include <windows.h>
#include <shellapi.h>
#include <psapi.h>
#include <UIAutomationClient.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// initguid.h emits the GUIDs declared in mmdeviceapi.h / endpointvolume.h
// into this translation unit so we don't need to link -lmmdevapi.

static std::string toUtf8(const wchar_t* s, int len)
{
    if (len <= 0) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, s, len, NULL, 0, NULL, NULL);
    if (n <= 0) return std::string();
    std::string out((size_t)n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, s, len, &out[0], n, NULL, NULL);
    return out;
}

static std::string jsonEscape(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 2);
    out.push_back('"');
    for (size_t i = 0; i < s.size(); ++i) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back((char)c);
                }
        }
    }
    out.push_back('"');
    return out;
}

static void emitRaw(const char* s)
{
    fwrite(s, 1, strlen(s), stdout);
}

// ---------------------------------------------------------------------------
// Probe: foreground window + UIA-focused-element editable check.
// ---------------------------------------------------------------------------

struct ForegroundInfo {
    DWORD pid;
    std::string exeName;
    bool ok;
};

static ForegroundInfo getForegroundInfo()
{
    ForegroundInfo info{ 0, std::string(), false };
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) return info;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (!pid) return info;
    info.pid = pid;
    info.ok = true;

    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hProc) {
        wchar_t path[MAX_PATH] = {};
        DWORD size = MAX_PATH;
        if (QueryFullProcessImageNameW(hProc, 0, path, &size) && size > 0) {
            const wchar_t* name = path;
            for (const wchar_t* p = path; *p; ++p) {
                if (*p == L'\\' || *p == L'/') name = p + 1;
            }
            info.exeName = toUtf8(name, (int)wcslen(name));
        }
        CloseHandle(hProc);
    }
    return info;
}

static bool focusedElementIsEditable(IUIAutomation* uia)
{
    IUIAutomationElement* focused = nullptr;
    if (FAILED(uia->GetFocusedElement(&focused)) || !focused) return false;

    bool editable = false;
    CONTROLTYPEID ctid = 0;
    if (SUCCEEDED(focused->get_CurrentControlType(&ctid))) {
        if (ctid == UIA_EditControlTypeId
            || ctid == UIA_DocumentControlTypeId
            || ctid == UIA_ComboBoxControlTypeId) {
            editable = true;
        }
    }

    if (!editable) {
        IUnknown* unk = nullptr;
        if (SUCCEEDED(focused->GetCurrentPattern(UIA_ValuePatternId, &unk)) && unk) {
            IUIAutomationValuePattern* vp = nullptr;
            if (SUCCEEDED(unk->QueryInterface(__uuidof(IUIAutomationValuePattern), (void**)&vp)) && vp) {
                BOOL readOnly = TRUE;
                if (SUCCEEDED(vp->get_CurrentIsReadOnly(&readOnly)) && !readOnly) {
                    editable = true;
                }
                vp->Release();
            }
            unk->Release();
        }
    }

    if (!editable) {
        IUnknown* unk = nullptr;
        if (SUCCEEDED(focused->GetCurrentPattern(UIA_TextPatternId, &unk)) && unk) {
            // TextPattern alone implies a text-bearing control with caret support
            // in nearly every host (Edge/Chromium edits, Office, native edits).
            editable = true;
            unk->Release();
        }
    }

    focused->Release();
    return editable;
}

static bool caretWindowEditable()
{
    GUITHREADINFO info{};
    info.cbSize = sizeof(info);
    if (!GetGUIThreadInfo(0, &info)) return false;
    return info.hwndCaret != NULL;
}

static void doProbe()
{
    ForegroundInfo info = getForegroundInfo();
    bool editable = false;

    HRESULT hrCo = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    bool needUninit = SUCCEEDED(hrCo);
    if (needUninit || hrCo == RPC_E_CHANGED_MODE) {
        IUIAutomation* uia = nullptr;
        HRESULT hr = CoCreateInstance(
            __uuidof(CUIAutomation),
            NULL,
            CLSCTX_INPROC_SERVER,
            __uuidof(IUIAutomation),
            (void**)&uia);
        if (SUCCEEDED(hr) && uia) {
            editable = focusedElementIsEditable(uia);
            uia->Release();
        }
        if (needUninit) CoUninitialize();
    }
    if (!editable) editable = caretWindowEditable();

    std::string out = "{\"ok\":";
    out += info.ok ? "true" : "false";
    if (info.ok) {
        out += ",\"frontmostBundleId\":";
        out += jsonEscape(info.exeName);
        out += ",\"frontmostPid\":";
        out += std::to_string((unsigned long)info.pid);
    }
    out += ",\"focusedEditable\":";
    out += editable ? "true" : "false";
    out += "}";
    fwrite(out.data(), 1, out.size(), stdout);
}

// ---------------------------------------------------------------------------
// Paste: snapshot clipboard, write text, send Ctrl+V, restore.
// ---------------------------------------------------------------------------

struct ClipboardEntry {
    UINT format;
    std::vector<unsigned char> data;
};

static std::vector<ClipboardEntry> snapshotClipboard()
{
    std::vector<ClipboardEntry> snapshot;
    if (!OpenClipboard(NULL)) return snapshot;
    UINT format = 0;
    while ((format = EnumClipboardFormats(format)) != 0) {
        HANDLE h = GetClipboardData(format);
        if (!h) continue;
        SIZE_T size = GlobalSize(h);
        if (!size) continue;
        void* src = GlobalLock(h);
        if (!src) continue;
        ClipboardEntry entry;
        entry.format = format;
        entry.data.assign((unsigned char*)src, (unsigned char*)src + size);
        GlobalUnlock(h);
        snapshot.push_back(std::move(entry));
    }
    CloseClipboard();
    return snapshot;
}

static void restoreClipboard(const std::vector<ClipboardEntry>& snapshot)
{
    if (!OpenClipboard(NULL)) return;
    EmptyClipboard();
    for (size_t i = 0; i < snapshot.size(); ++i) {
        const ClipboardEntry& entry = snapshot[i];
        HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, entry.data.size());
        if (!h) continue;
        void* dst = GlobalLock(h);
        if (!dst) { GlobalFree(h); continue; }
        memcpy(dst, entry.data.data(), entry.data.size());
        GlobalUnlock(h);
        if (!SetClipboardData(entry.format, h)) {
            GlobalFree(h);
        }
    }
    CloseClipboard();
}

static bool writeClipboardText(const std::wstring& ws)
{
    if (!OpenClipboard(NULL)) return false;
    EmptyClipboard();
    SIZE_T bytes = (ws.size() + 1) * sizeof(wchar_t);
    HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (!h) { CloseClipboard(); return false; }
    void* dst = GlobalLock(h);
    if (!dst) { GlobalFree(h); CloseClipboard(); return false; }
    memcpy(dst, ws.c_str(), bytes);
    GlobalUnlock(h);
    bool ok = SetClipboardData(CF_UNICODETEXT, h) != NULL;
    if (!ok) GlobalFree(h);
    CloseClipboard();
    return ok;
}

static bool sendCtrlV()
{
    INPUT in[4];
    memset(in, 0, sizeof(in));
    in[0].type = INPUT_KEYBOARD;
    in[0].ki.wVk = VK_CONTROL;
    in[1].type = INPUT_KEYBOARD;
    in[1].ki.wVk = 'V';
    in[2].type = INPUT_KEYBOARD;
    in[2].ki.wVk = 'V';
    in[2].ki.dwFlags = KEYEVENTF_KEYUP;
    in[3].type = INPUT_KEYBOARD;
    in[3].ki.wVk = VK_CONTROL;
    in[3].ki.dwFlags = KEYEVENTF_KEYUP;
    UINT n = SendInput(4, in, sizeof(INPUT));
    return n == 4;
}

static void doPaste(const std::wstring& text)
{
    std::vector<ClipboardEntry> snapshot = snapshotClipboard();
    if (!writeClipboardText(text)) {
        emitRaw("{\"ok\":false,\"error\":\"clipboard write failed\"}");
        return;
    }
    Sleep(40);
    bool sent = sendCtrlV();
    Sleep(500);
    restoreClipboard(snapshot);
    if (sent) {
        emitRaw("{\"ok\":true,\"strategy\":\"ctrl-v\"}");
    } else {
        emitRaw("{\"ok\":false,\"error\":\"SendInput failed\"}");
    }
}

// ---------------------------------------------------------------------------
// Audio mute/restore via Core Audio (WASAPI).
// ---------------------------------------------------------------------------

static IAudioEndpointVolume* openEndpointVolume()
{
    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        NULL,
        CLSCTX_INPROC_SERVER,
        __uuidof(IMMDeviceEnumerator),
        (void**)&enumerator);
    if (FAILED(hr) || !enumerator) return nullptr;

    IMMDevice* device = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    enumerator->Release();
    if (FAILED(hr) || !device) return nullptr;

    IAudioEndpointVolume* volume = nullptr;
    hr = device->Activate(
        __uuidof(IAudioEndpointVolume),
        CLSCTX_INPROC_SERVER,
        NULL,
        (void**)&volume);
    device->Release();
    if (FAILED(hr) || !volume) return nullptr;
    return volume;
}

static void doMuteOutput()
{
    HRESULT hrCo = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    bool needUninit = SUCCEEDED(hrCo);
    if (!needUninit && hrCo != RPC_E_CHANGED_MODE) {
        emitRaw("{\"ok\":false,\"error\":\"CoInitialize failed\"}");
        return;
    }

    IAudioEndpointVolume* vol = openEndpointVolume();
    if (!vol) {
        emitRaw("{\"ok\":false,\"error\":\"endpoint open failed\"}");
        if (needUninit) CoUninitialize();
        return;
    }

    float scalar = 0.0f;
    BOOL muted = FALSE;
    HRESULT hrV = vol->GetMasterVolumeLevelScalar(&scalar);
    HRESULT hrM = vol->GetMute(&muted);
    if (FAILED(hrV) || FAILED(hrM)) {
        vol->Release();
        if (needUninit) CoUninitialize();
        emitRaw("{\"ok\":false,\"error\":\"read state failed\"}");
        return;
    }

    HRESULT hrSet = vol->SetMute(TRUE, NULL);
    vol->Release();
    if (needUninit) CoUninitialize();

    if (FAILED(hrSet)) {
        emitRaw("{\"ok\":false,\"error\":\"set mute failed\"}");
        return;
    }

    char buf[160];
    int n = snprintf(
        buf,
        sizeof(buf),
        "{\"ok\":true,\"previousVolume\":%g,\"previousMuted\":%s}",
        (double)scalar,
        muted ? "true" : "false");
    if (n > 0) fwrite(buf, 1, (size_t)n, stdout);
}

static void doRestoreOutput(const char* prevVolStr, const char* prevMutedStr)
{
    if (!prevVolStr) {
        emitRaw("{\"ok\":false,\"error\":\"missing previous volume\"}");
        return;
    }
    bool prevMuted = false;
    if (prevMutedStr
        && (strcmp(prevMutedStr, "true") == 0 || strcmp(prevMutedStr, "1") == 0)) {
        prevMuted = true;
    }

    HRESULT hrCo = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    bool needUninit = SUCCEEDED(hrCo);
    if (!needUninit && hrCo != RPC_E_CHANGED_MODE) {
        emitRaw("{\"ok\":false,\"error\":\"CoInitialize failed\"}");
        return;
    }

    IAudioEndpointVolume* vol = openEndpointVolume();
    if (!vol) {
        emitRaw("{\"ok\":false,\"error\":\"endpoint open failed\"}");
        if (needUninit) CoUninitialize();
        return;
    }

    HRESULT hrM = vol->SetMute(prevMuted ? TRUE : FALSE, NULL);
    vol->Release();
    if (needUninit) CoUninitialize();

    if (FAILED(hrM)) {
        emitRaw("{\"ok\":false,\"error\":\"set mute failed\"}");
        return;
    }
    emitRaw("{\"ok\":true}");
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

static std::wstring joinWideArgs(int wArgc, LPWSTR* wArgv, int startIndex)
{
    std::wstring out;
    for (int i = startIndex; i < wArgc; ++i) {
        if (i > startIndex) out.push_back(L' ');
        out.append(wArgv[i]);
    }
    return out;
}

int main(int argc, char* argv[])
{
    if (argc < 2) {
        emitRaw("{\"ok\":false,\"error\":\"missing command\"}");
        return 2;
    }
    const char* cmd = argv[1];

    if (strcmp(cmd, "probe") == 0) {
        doProbe();
        return 0;
    }
    if (strcmp(cmd, "paste") == 0) {
        // Re-fetch wide arguments so non-ASCII transcripts survive the CRT
        // narrow-arg conversion.
        int wArgc = 0;
        LPWSTR* wArgv = CommandLineToArgvW(GetCommandLineW(), &wArgc);
        std::wstring text;
        if (wArgv && wArgc > 2) {
            text = joinWideArgs(wArgc, wArgv, 2);
        }
        if (wArgv) LocalFree(wArgv);
        doPaste(text);
        return 0;
    }
    if (strcmp(cmd, "mute-output") == 0) {
        doMuteOutput();
        return 0;
    }
    if (strcmp(cmd, "restore-output") == 0) {
        const char* a1 = argc > 2 ? argv[2] : NULL;
        const char* a2 = argc > 3 ? argv[3] : NULL;
        doRestoreOutput(a1, a2);
        return 0;
    }

    emitRaw("{\"ok\":false,\"error\":\"unknown command\"}");
    return 2;
}
