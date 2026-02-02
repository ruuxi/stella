// window_info.exe - Returns JSON info about the window at a given screen point
// Usage: window_info.exe <x> <y>
// Output: {"title":"...","process":"...","pid":123,"bounds":{"x":0,"y":0,"width":800,"height":600}}
// Compile: cl /O2 /EHsc window_info.cpp /link user32.lib /OUT:window_info.exe

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <string>

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

    HWND hwnd = WindowFromPoint(pt);
    if (!hwnd)
    {
        printf("{\"error\":\"no window at point\"}\n");
        return 0;
    }

    // Walk up to the top-level (non-child) window
    HWND root = GetAncestor(hwnd, GA_ROOT);
    if (root) hwnd = root;

    // Title
    char title[512] = {};
    GetWindowTextA(hwnd, title, sizeof(title));

    // Bounds
    RECT rect = {};
    GetWindowRect(hwnd, &rect);

    // PID + process name
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);

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
