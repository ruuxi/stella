// recent_apps.exe - Enumerate user-facing top-level windowed processes for
// the home "recent apps" context chips. Replaces a per-poll PowerShell
// snapshot (PowerShell cold start + Get-Process MainWindowHandle + per-process
// MainModule.FileName) with a single in-process EnumWindows walk.
//
// Output: JSON array, one entry per windowed process (deduped by pid):
//   [{"ProcessName":"chrome","Id":1234,"MainWindowTitle":"...",
//     "IsActive":true,"ExecutablePath":"C:\\Program Files\\..."}]
// Matches the field shape the renderer already parses from the PowerShell
// path so the desktop-side cleaning/filtering code is shared.
//
// Compile: cl /O2 /EHsc recent_apps.cpp /link user32.lib dwmapi.lib /OUT:recent_apps.exe
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#pragma comment(lib, "dwmapi.lib")

static std::string escapeJson(const char* s)
{
    std::string out;
    for (; *s; ++s)
    {
        switch (*s)
        {
        case '"':  out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:   out += *s; break;
        }
    }
    return out;
}

static bool isWindowCloaked(HWND hwnd)
{
    BOOL cloaked = FALSE;
    HRESULT result = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    return SUCCEEDED(result) && cloaked;
}

struct AppEntry
{
    DWORD pid;
    std::string name;
    std::string title;
    std::string exePath;
    bool active;
};

static std::vector<AppEntry> g_entries;
static DWORD g_foregroundPid = 0;

static BOOL CALLBACK enumWindowsProc(HWND hwnd, LPARAM /*lparam*/)
{
    if (!IsWindowVisible(hwnd))
    {
        return TRUE;
    }
    if (isWindowCloaked(hwnd))
    {
        return TRUE;
    }

    // Alt-tab style heuristic: only user-facing top-level app windows. Skip
    // tool windows and any window that isn't its own root owner (dialogs,
    // owned popups), which is roughly what `MainWindowHandle` surfaced.
    if (GetAncestor(hwnd, GA_ROOTOWNER) != hwnd)
    {
        return TRUE;
    }
    LONG exStyle = GetWindowLongA(hwnd, GWL_EXSTYLE);
    if (exStyle & WS_EX_TOOLWINDOW)
    {
        return TRUE;
    }

    int titleLen = GetWindowTextLengthA(hwnd);
    if (titleLen <= 0)
    {
        return TRUE;
    }
    std::vector<char> titleBuf(static_cast<size_t>(titleLen) + 1, 0);
    GetWindowTextA(hwnd, titleBuf.data(), titleLen + 1);

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0)
    {
        return TRUE;
    }

    // Dedup by pid. EnumWindows walks top-of-z-order first, so the first
    // window seen for a pid is its topmost.
    for (size_t i = 0; i < g_entries.size(); ++i)
    {
        if (g_entries[i].pid == pid)
        {
            return TRUE;
        }
    }

    char exePath[MAX_PATH] = {};
    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hProc)
    {
        DWORD size = MAX_PATH;
        QueryFullProcessImageNameA(hProc, 0, exePath, &size);
        CloseHandle(hProc);
    }

    // Process name = exe basename without extension (matches PowerShell's
    // Get-Process ProcessName; the renderer also strips ".exe" defensively).
    const char* base = exePath;
    for (const char* p = exePath; *p; ++p)
    {
        if (*p == '\\' || *p == '/')
        {
            base = p + 1;
        }
    }
    std::string name = base;
    const size_t dot = name.rfind('.');
    if (dot != std::string::npos)
    {
        name = name.substr(0, dot);
    }

    AppEntry entry;
    entry.pid = pid;
    entry.name = name;
    entry.title = std::string(titleBuf.data());
    entry.exePath = exePath;
    entry.active = (pid == g_foregroundPid && g_foregroundPid != 0);
    g_entries.push_back(entry);
    return TRUE;
}

int main(int /*argc*/, char* /*argv*/[])
{
    HWND foreground = GetForegroundWindow();
    if (foreground)
    {
        GetWindowThreadProcessId(foreground, &g_foregroundPid);
    }

    EnumWindows(enumWindowsProc, 0);

    std::string out = "[";
    for (size_t i = 0; i < g_entries.size(); ++i)
    {
        if (i)
        {
            out += ",";
        }
        const AppEntry& e = g_entries[i];
        out += "{\"ProcessName\":\"";
        out += escapeJson(e.name.c_str());
        out += "\",\"Id\":";
        out += std::to_string(static_cast<unsigned long>(e.pid));
        out += ",\"MainWindowTitle\":\"";
        out += escapeJson(e.title.c_str());
        out += "\",\"IsActive\":";
        out += (e.active ? "true" : "false");
        out += ",\"ExecutablePath\":\"";
        out += escapeJson(e.exePath.c_str());
        out += "\"}";
    }
    out += "]";
    printf("%s\n", out.c_str());
    return 0;
}
