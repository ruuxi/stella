// window_info.exe - Returns JSON info about the window at a given screen point
// Usage: window_info.exe <x> <y>
// Output: {"title":"...","process":"...","pid":123,"bounds":{"x":0,"y":0,"width":800,"height":600}}
// Compile: cl /O2 /EHsc window_info.cpp /link user32.lib /OUT:window_info.exe

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <cstring>

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

static bool isPidExcluded(DWORD pid, const std::vector<DWORD>& excluded)
{
    for (DWORD value : excluded)
    {
        if (value == pid)
        {
            return true;
        }
    }
    return false;
}

static void parseExcludePidsArg(const char* arg, std::vector<DWORD>& excluded)
{
    const char* prefix = "--exclude-pids=";
    const size_t prefixLen = strlen(prefix);
    if (strncmp(arg, prefix, prefixLen) != 0)
    {
        return;
    }

    const char* p = arg + prefixLen;
    while (*p)
    {
        while (*p == ',' || *p == ' ')
        {
            ++p;
        }
        if (!*p)
        {
            break;
        }

        char* end = nullptr;
        unsigned long pid = strtoul(p, &end, 10);
        if (end == p)
        {
            break;
        }
        if (pid > 0)
        {
            excluded.push_back(static_cast<DWORD>(pid));
        }
        p = end;
        while (*p && *p != ',')
        {
            ++p;
        }
    }
}

static HWND findTopLevelWindowAtPoint(POINT pt, const std::vector<DWORD>& excludedPids)
{
    for (HWND hwnd = GetTopWindow(NULL); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT))
    {
        if (!IsWindowVisible(hwnd))
        {
            continue;
        }

        RECT rect = {};
        if (!GetWindowRect(hwnd, &rect))
        {
            continue;
        }
        if (rect.right <= rect.left || rect.bottom <= rect.top)
        {
            continue;
        }
        if (pt.x < rect.left || pt.x >= rect.right || pt.y < rect.top || pt.y >= rect.bottom)
        {
            continue;
        }

        DWORD pid = 0;
        GetWindowThreadProcessId(hwnd, &pid);
        if (isPidExcluded(pid, excludedPids))
        {
            continue;
        }

        return hwnd;
    }

    return NULL;
}

int main(int argc, char* argv[])
{
    if (argc < 3)
    {
        fprintf(stderr, "Usage: window_info <x> <y>\n");
        return 1;
    }

    POINT pt;
    pt.x = atol(argv[1]);
    pt.y = atol(argv[2]);

    std::vector<DWORD> excludedPids;
    for (int i = 3; i < argc; ++i)
    {
        parseExcludePidsArg(argv[i], excludedPids);
    }

    HWND hwnd = findTopLevelWindowAtPoint(pt, excludedPids);
    if (!hwnd)
    {
        hwnd = WindowFromPoint(pt);
    }
    if (!hwnd)
    {
        printf("{\"error\":\"no window at point\"}\n");
        return 0;
    }

    // Walk up to the top-level (non-child) window
    HWND root = GetAncestor(hwnd, GA_ROOT);
    if (root) hwnd = root;

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (isPidExcluded(pid, excludedPids))
    {
        printf("{\"error\":\"no non-excluded window at point\"}\n");
        return 0;
    }

    // Title
    char title[512] = {};
    GetWindowTextA(hwnd, title, sizeof(title));

    // Bounds
    RECT rect = {};
    GetWindowRect(hwnd, &rect);

    // PID + process name
    char processName[MAX_PATH] = {};
    if (pid)
    {
        HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (hProc)
        {
            DWORD size = MAX_PATH;
            QueryFullProcessImageNameA(hProc, 0, processName, &size);
            CloseHandle(hProc);
        }
    }

    // Extract just the exe name from the full path
    const char* exeName = processName;
    const char* p = processName;
    for (; *p; ++p)
    {
        if (*p == '\\' || *p == '/')
            exeName = p + 1;
    }

    int w = rect.right - rect.left;
    int h = rect.bottom - rect.top;

    printf("{\"title\":\"%s\",\"process\":\"%s\",\"pid\":%lu,\"bounds\":{\"x\":%ld,\"y\":%ld,\"width\":%d,\"height\":%d}}\n",
           escapeJson(title).c_str(),
           escapeJson(exeName).c_str(),
           pid,
           rect.left, rect.top, w, h);

    return 0;
}
