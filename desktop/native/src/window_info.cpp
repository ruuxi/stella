// window_info.exe - Returns JSON info about the window at a given screen point
// Usage: window_info.exe <x> <y> [--exclude-pids=1,2,3] [--screenshot=path.png] [--set-bounds=x,y,w,h]
// Output: {"title":"...","process":"...","pid":123,"bounds":{"x":0,"y":0,"width":800,"height":600}}
// Compile: cl /O2 /EHsc window_info.cpp /link user32.lib gdi32.lib gdiplus.lib ole32.lib dwmapi.lib /OUT:window_info.exe

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <objidl.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <cstring>
#include <gdiplus.h>

#pragma comment(lib, "gdiplus.lib")
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

static bool isWindowCloaked(HWND hwnd)
{
    BOOL cloaked = FALSE;
    HRESULT result = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    return SUCCEEDED(result) && cloaked;
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

static bool parseSetBoundsArg(const char* arg, RECT& rect)
{
    const char* prefix = "--set-bounds=";
    const size_t prefixLen = strlen(prefix);
    if (strncmp(arg, prefix, prefixLen) != 0)
    {
        return false;
    }

    const char* p = arg + prefixLen;
    long values[4] = {};
    for (int i = 0; i < 4; ++i)
    {
        char* end = nullptr;
        values[i] = strtol(p, &end, 10);
        if (end == p)
        {
            return false;
        }
        p = end;
        if (i < 3)
        {
            if (*p != ',') return false;
            ++p;
        }
    }

    if (values[2] <= 0 || values[3] <= 0)
    {
        return false;
    }

    rect.left = values[0];
    rect.top = values[1];
    rect.right = values[0] + values[2];
    rect.bottom = values[1] + values[3];
    return true;
}

static HWND findTopLevelWindowAtPoint(POINT pt, const std::vector<DWORD>& excludedPids)
{
    for (HWND hwnd = GetTopWindow(NULL); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT))
    {
        if (!IsWindowVisible(hwnd))
        {
            continue;
        }
        if (IsIconic(hwnd) || isWindowCloaked(hwnd))
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

static int GetPngEncoderClsid(CLSID* clsid)
{
    UINT num = 0, size = 0;
    Gdiplus::GetImageEncodersSize(&num, &size);
    if (size == 0) return -1;

    std::vector<BYTE> buf(size);
    Gdiplus::ImageCodecInfo* codecs = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
    Gdiplus::GetImageEncoders(num, size, codecs);

    for (UINT i = 0; i < num; ++i)
    {
        if (wcscmp(codecs[i].MimeType, L"image/png") == 0)
        {
            *clsid = codecs[i].Clsid;
            return static_cast<int>(i);
        }
    }
    return -1;
}

static bool captureWindowToFile(HWND hwnd, const wchar_t* filePath)
{
    RECT rect = {};
    GetWindowRect(hwnd, &rect);
    int w = rect.right - rect.left;
    int h = rect.bottom - rect.top;
    if (w <= 0 || h <= 0) return false;

    HDC hdcScreen = GetDC(NULL);
    HDC hdcMem = CreateCompatibleDC(hdcScreen);
    HBITMAP hBitmap = CreateCompatibleBitmap(hdcScreen, w, h);
    HGDIOBJ hOld = SelectObject(hdcMem, hBitmap);

    // PW_RENDERFULLCONTENT (0x2) captures the full window including DWM-composited content
    BOOL ok = PrintWindow(hwnd, hdcMem, 2);
    if (!ok)
    {
        // Fallback: try without PW_RENDERFULLCONTENT
        ok = PrintWindow(hwnd, hdcMem, 0);
    }

    bool saved = false;
    if (ok)
    {
        Gdiplus::Bitmap bitmap(hBitmap, NULL);
        CLSID pngClsid;
        if (GetPngEncoderClsid(&pngClsid) >= 0)
        {
            saved = (bitmap.Save(filePath, &pngClsid, NULL) == Gdiplus::Ok);
        }
    }

    SelectObject(hdcMem, hOld);
    DeleteObject(hBitmap);
    DeleteDC(hdcMem);
    ReleaseDC(NULL, hdcScreen);
    return saved;
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
    const char* screenshotPath = nullptr;
    RECT setBounds = {};
    bool hasSetBounds = false;

    for (int i = 3; i < argc; ++i)
    {
        parseExcludePidsArg(argv[i], excludedPids);
        if (parseSetBoundsArg(argv[i], setBounds))
        {
            hasSetBounds = true;
        }
        const char* ssPrefix = "--screenshot=";
        size_t ssPrefixLen = strlen(ssPrefix);
        if (strncmp(argv[i], ssPrefix, ssPrefixLen) == 0)
        {
            screenshotPath = argv[i] + ssPrefixLen;
        }
    }

    // Initialize GDI+ only when screenshot is requested
    ULONG_PTR gdiplusToken = 0;
    if (screenshotPath)
    {
        Gdiplus::GdiplusStartupInput gdiplusStartupInput;
        Gdiplus::GdiplusStartup(&gdiplusToken, &gdiplusStartupInput, NULL);
    }

    HWND hwnd = findTopLevelWindowAtPoint(pt, excludedPids);
    if (!hwnd)
    {
        // Fallback: WindowFromPoint can find child/nested windows that the
        // top-level z-order walk misses, but we must still respect PID exclusion.
        hwnd = WindowFromPoint(pt);
        if (hwnd)
        {
            HWND fallbackRoot = GetAncestor(hwnd, GA_ROOT);
            if (fallbackRoot) hwnd = fallbackRoot;

            if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || isWindowCloaked(hwnd))
            {
                hwnd = NULL;
            }

            DWORD fallbackPid = 0;
            if (hwnd)
            {
                GetWindowThreadProcessId(hwnd, &fallbackPid);
                if (isPidExcluded(fallbackPid, excludedPids))
                {
                    hwnd = NULL;
                }
            }
        }
    }
    if (!hwnd)
    {
        printf("{\"error\":\"no window at point\"}\n");
        if (gdiplusToken) Gdiplus::GdiplusShutdown(gdiplusToken);
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
    bool moved = false;
    RECT outputRect = rect;

    if (hasSetBounds)
    {
        if (IsIconic(hwnd) || IsZoomed(hwnd))
        {
            ShowWindow(hwnd, SW_RESTORE);
        }

        int targetW = static_cast<int>(setBounds.right - setBounds.left);
        int targetH = static_cast<int>(setBounds.bottom - setBounds.top);
        moved = SetWindowPos(
            hwnd,
            NULL,
            setBounds.left,
            setBounds.top,
            targetW,
            targetH,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER
        ) != 0;
        GetWindowRect(hwnd, &outputRect);
        w = outputRect.right - outputRect.left;
        h = outputRect.bottom - outputRect.top;
    }

    printf("{\"title\":\"%s\",\"process\":\"%s\",\"pid\":%lu,\"bounds\":{\"x\":%ld,\"y\":%ld,\"width\":%d,\"height\":%d},\"moved\":%s}\n",
           escapeJson(title).c_str(),
           escapeJson(exeName).c_str(),
           pid,
           outputRect.left, outputRect.top, w, h,
           moved ? "true" : "false");

    // Capture screenshot if requested
    if (screenshotPath)
    {
        // Convert path to wide string
        int wideLen = MultiByteToWideChar(CP_UTF8, 0, screenshotPath, -1, NULL, 0);
        std::vector<wchar_t> widePath(wideLen);
        MultiByteToWideChar(CP_UTF8, 0, screenshotPath, -1, widePath.data(), wideLen);

        captureWindowToFile(hwnd, widePath.data());
        Gdiplus::GdiplusShutdown(gdiplusToken);
    }

    return 0;
}
