// window_info.exe - Returns JSON info about the window at a given screen point
// Usage: window_info.exe <x> <y> [--exclude-pids=1,2,3] [--exclude-title-prefixes=Title] [--screenshot=path.png] [--set-bounds=x,y,w,h]
//        window_info.exe --shot <x> <y> | --shot --pid=<pid>   (inline base64 JPEG capture)
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
#include <iostream>
#include <gdiplus.h>
#include <cctype>

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

struct WindowExclusions
{
    std::vector<DWORD> pids;
    std::vector<std::string> titlePrefixes;
};

static std::string getWindowTitle(HWND hwnd);

static std::string lowerAscii(const std::string& input)
{
    std::string out = input;
    for (char& c : out)
    {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
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

static bool startsWith(const std::string& value, const std::string& prefix)
{
    return value.size() >= prefix.size()
        && value.compare(0, prefix.size(), prefix) == 0;
}

static bool isWindowExcluded(HWND hwnd, const WindowExclusions& excluded)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (isPidExcluded(pid, excluded.pids))
    {
        return true;
    }
    if (!excluded.titlePrefixes.empty())
    {
        const std::string title = lowerAscii(getWindowTitle(hwnd));
        for (const std::string& prefix : excluded.titlePrefixes)
        {
            if (!prefix.empty() && startsWith(title, prefix))
            {
                return true;
            }
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

static std::string getWindowTitle(HWND hwnd)
{
    char title[512] = {};
    DWORD_PTR copied = 0;
    LRESULT ok = SendMessageTimeoutA(
        hwnd,
        WM_GETTEXT,
        static_cast<WPARAM>(sizeof(title)),
        reinterpret_cast<LPARAM>(title),
        SMTO_ABORTIFHUNG | SMTO_BLOCK,
        80,
        &copied
    );
    if (!ok || copied == 0)
    {
        return "";
    }
    title[sizeof(title) - 1] = '\0';
    return std::string(title);
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

static void parseExcludeTitlePrefixesArg(const char* arg, std::vector<std::string>& excluded)
{
    const char* prefix = "--exclude-title-prefixes=";
    const size_t prefixLen = strlen(prefix);
    if (strncmp(arg, prefix, prefixLen) != 0)
    {
        return;
    }

    const char* p = arg + prefixLen;
    while (*p)
    {
        while (*p == ',')
        {
            ++p;
        }
        if (!*p)
        {
            break;
        }

        const char* start = p;
        while (*p && *p != ',')
        {
            ++p;
        }
        std::string value(start, p - start);
        while (!value.empty() && value.front() == ' ')
        {
            value.erase(value.begin());
        }
        while (!value.empty() && value.back() == ' ')
        {
            value.pop_back();
        }
        if (!value.empty())
        {
            excluded.push_back(lowerAscii(value));
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

// Parse `--region=x,y,w,h` (virtual-screen physical pixels) into x/y/w/h.
static bool parseRegionArg(const char* arg, int& x, int& y, int& w, int& h)
{
    const char* prefix = "--region=";
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

    x = static_cast<int>(values[0]);
    y = static_cast<int>(values[1]);
    w = static_cast<int>(values[2]);
    h = static_cast<int>(values[3]);
    return true;
}

// Parse `--pid=<pid>` into a process id (0 = not this arg / invalid).
static bool parsePidArg(const char* arg, DWORD& outPid)
{
    const char* prefix = "--pid=";
    const size_t prefixLen = strlen(prefix);
    if (strncmp(arg, prefix, prefixLen) != 0)
    {
        return false;
    }
    char* end = nullptr;
    unsigned long pid = strtoul(arg + prefixLen, &end, 10);
    if (end == arg + prefixLen || pid == 0)
    {
        return false;
    }
    outPid = static_cast<DWORD>(pid);
    return true;
}

static bool parsePointsArg(const char* arg, std::vector<POINT>& outPoints)
{
    const char* prefix = "--points=";
    const size_t prefixLen = strlen(prefix);
    if (strncmp(arg, prefix, prefixLen) != 0)
    {
        return false;
    }

    const char* p = arg + prefixLen;
    while (*p)
    {
        char* end = nullptr;
        long x = strtol(p, &end, 10);
        if (end == p)
        {
            break;
        }
        p = end;
        if (*p != ',')
        {
            break;
        }
        ++p;

        long y = strtol(p, &end, 10);
        if (end == p)
        {
            break;
        }
        p = end;

        POINT pt;
        pt.x = x;
        pt.y = y;
        outPoints.push_back(pt);

        while (*p && *p != ';')
        {
            ++p;
        }
        if (*p == ';')
        {
            ++p;
        }
    }
    return true;
}

static HWND findTopLevelWindowAtPoint(POINT pt, const WindowExclusions& excluded)
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

        if (isWindowExcluded(hwnd, excluded))
        {
            continue;
        }

        return hwnd;
    }

    return NULL;
}

// Topmost top-level window at `pt` as a JSON object string
// (`{title,process,pid,bounds}`) or "null". Reuses the same
// findTopLevelWindowAtPoint z-order walk as the single-point path; used by
// the batch `--points` mode so one process invocation answers many points
// (instead of one CreateProcess per point — the costly part on Windows).
static std::string windowInfoJsonAtPoint(POINT pt, const WindowExclusions& excluded)
{
    HWND hwnd = findTopLevelWindowAtPoint(pt, excluded);
    if (!hwnd)
    {
        return "null";
    }

    std::string title = getWindowTitle(hwnd);

    RECT rect = {};
    GetWindowRect(hwnd, &rect);

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

    const char* exeName = processName;
    for (const char* p = processName; *p; ++p)
    {
        if (*p == '\\' || *p == '/')
            exeName = p + 1;
    }

    int w = rect.right - rect.left;
    int h = rect.bottom - rect.top;

    std::string out = "{\"title\":\"";
    out += escapeJson(title.c_str());
    out += "\",\"process\":\"";
    out += escapeJson(exeName);
    out += "\",\"pid\":";
    out += std::to_string(static_cast<unsigned long>(pid));
    out += ",\"bounds\":{\"x\":";
    out += std::to_string(static_cast<long>(rect.left));
    out += ",\"y\":";
    out += std::to_string(static_cast<long>(rect.top));
    out += ",\"width\":";
    out += std::to_string(w);
    out += ",\"height\":";
    out += std::to_string(h);
    out += "}}";
    return out;
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

// ── Fast capture path (base64, no temp file) ────────────────────────────
// The desktop's hot composer capture path wants a window/region screenshot as
// fast as possible. The legacy
// `--screenshot=path` path PNG-encodes to disk, which the host then re-reads
// and re-encodes — three image passes plus disk I/O. These helpers instead
// BitBlt/PrintWindow into an in-memory bitmap, JPEG-encode it (far cheaper
// than PNG for a large window), and base64 it straight onto stdout / the
// --serve pipe so the host consumes the data URL with no decode/re-encode.

// Per-monitor DPI awareness so GetWindowRect and screen-DC BitBlt coordinates
// are real physical pixels (the host sends physical coords = DIP * scaleFactor
// and divides returned bounds back by scaleFactor). At 100% scale this is a
// no-op; on HiDPI it's what makes region BitBlt land on the right pixels.
static void enableDpiAwareness()
{
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    if (user32)
    {
        // SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2 = (HANDLE)-4),
        // Windows 10 1703+. Loaded dynamically so the helper still builds and
        // runs on older SDKs / OSes that lack the symbol.
        typedef BOOL(WINAPI * SetCtxFn)(HANDLE);
        SetCtxFn setCtx =
            reinterpret_cast<SetCtxFn>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
        if (setCtx && setCtx(reinterpret_cast<HANDLE>(static_cast<INT_PTR>(-4))))
        {
            return;
        }
    }
    SetProcessDPIAware();
}

static ULONG_PTR g_gdiplusToken = 0;
static void ensureGdiplus()
{
    if (g_gdiplusToken) return;
    Gdiplus::GdiplusStartupInput input;
    Gdiplus::GdiplusStartup(&g_gdiplusToken, &input, NULL);
}

static int GetJpegEncoderClsid(CLSID* clsid)
{
    UINT num = 0, size = 0;
    Gdiplus::GetImageEncodersSize(&num, &size);
    if (size == 0) return -1;

    std::vector<BYTE> buf(size);
    Gdiplus::ImageCodecInfo* codecs = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
    Gdiplus::GetImageEncoders(num, size, codecs);

    for (UINT i = 0; i < num; ++i)
    {
        if (wcscmp(codecs[i].MimeType, L"image/jpeg") == 0)
        {
            *clsid = codecs[i].Clsid;
            return static_cast<int>(i);
        }
    }
    return -1;
}

static std::string base64Encode(const BYTE* data, size_t len)
{
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    size_t i = 0;
    for (; i + 3 <= len; i += 3)
    {
        unsigned n = (static_cast<unsigned>(data[i]) << 16) |
                     (static_cast<unsigned>(data[i + 1]) << 8) |
                     static_cast<unsigned>(data[i + 2]);
        out += tbl[(n >> 18) & 63];
        out += tbl[(n >> 12) & 63];
        out += tbl[(n >> 6) & 63];
        out += tbl[n & 63];
    }
    const size_t rem = len - i;
    if (rem == 1)
    {
        unsigned n = static_cast<unsigned>(data[i]) << 16;
        out += tbl[(n >> 18) & 63];
        out += tbl[(n >> 12) & 63];
        out += '=';
        out += '=';
    }
    else if (rem == 2)
    {
        unsigned n = (static_cast<unsigned>(data[i]) << 16) |
                     (static_cast<unsigned>(data[i + 1]) << 8);
        out += tbl[(n >> 18) & 63];
        out += tbl[(n >> 12) & 63];
        out += tbl[(n >> 6) & 63];
        out += '=';
    }
    return out;
}

// JPEG-encode an HBITMAP into a base64 string (no line wrapping, so it stays a
// single line for the --serve protocol). Reports the encoded image dimensions.
static bool encodeBitmapToJpegBase64(HBITMAP hbmp, std::string& outB64, int& outW, int& outH)
{
    ensureGdiplus();
    Gdiplus::Bitmap bitmap(hbmp, NULL);
    if (bitmap.GetLastStatus() != Gdiplus::Ok) return false;
    outW = static_cast<int>(bitmap.GetWidth());
    outH = static_cast<int>(bitmap.GetHeight());

    CLSID jpegClsid;
    if (GetJpegEncoderClsid(&jpegClsid) < 0) return false;

    IStream* stream = NULL;
    if (CreateStreamOnHGlobal(NULL, TRUE, &stream) != S_OK || !stream) return false;

    ULONG quality = 80;
    Gdiplus::EncoderParameters params;
    params.Count = 1;
    params.Parameter[0].Guid = Gdiplus::EncoderQuality;
    params.Parameter[0].Type = Gdiplus::EncoderParameterValueTypeLong;
    params.Parameter[0].NumberOfValues = 1;
    params.Parameter[0].Value = &quality;

    bool ok = false;
    if (bitmap.Save(stream, &jpegClsid, &params) == Gdiplus::Ok)
    {
        STATSTG stat = {};
        if (stream->Stat(&stat, STATFLAG_NONAME) == S_OK)
        {
            const SIZE_T dataLen = static_cast<SIZE_T>(stat.cbSize.QuadPart);
            HGLOBAL hg = NULL;
            if (GetHGlobalFromStream(stream, &hg) == S_OK && hg)
            {
                BYTE* ptr = static_cast<BYTE*>(GlobalLock(hg));
                if (ptr)
                {
                    outB64 = base64Encode(ptr, dataLen);
                    GlobalUnlock(hg);
                    ok = !outB64.empty();
                }
            }
        }
    }

    stream->Release();
    return ok;
}

// BitBlt a virtual-screen rectangle (physical pixels) straight from the screen
// DC. Far cheaper than capturing every display at full resolution and cropping
// (what Electron's desktopCapturer does). Includes occluding windows, which is
// correct for a user-drawn region selection.
static bool captureRegionBase64(int x, int y, int w, int h, std::string& outB64, int& ow, int& oh)
{
    if (w <= 0 || h <= 0) return false;
    HDC hdcScreen = GetDC(NULL);
    if (!hdcScreen) return false;
    HDC hdcMem = CreateCompatibleDC(hdcScreen);
    HBITMAP hbmp = CreateCompatibleBitmap(hdcScreen, w, h);
    HGDIOBJ hOld = SelectObject(hdcMem, hbmp);

    // CAPTUREBLT so layered / alpha-blended windows are included.
    BOOL ok = BitBlt(hdcMem, 0, 0, w, h, hdcScreen, x, y, SRCCOPY | CAPTUREBLT);
    bool done = ok && encodeBitmapToJpegBase64(hbmp, outB64, ow, oh);

    SelectObject(hdcMem, hOld);
    DeleteObject(hbmp);
    DeleteDC(hdcMem);
    ReleaseDC(NULL, hdcScreen);
    return done;
}

// PrintWindow can "succeed" while producing an all-black (or otherwise
// uniform) bitmap for some GPU-composited / hardware-accelerated apps. Sample
// a sparse row grid and report whether every sampled pixel is identical so
// callers can treat the capture as failed and fall back. Alpha is masked out
// because PrintWindow often leaves it zeroed. Must be called while the bitmap
// is NOT selected into a DC (GetDIBits requirement).
static bool isBitmapUniform(HBITMAP hbmp, int w, int h)
{
    if (w <= 0 || h <= 0) return true;
    HDC hdc = GetDC(NULL);
    if (!hdc) return false;

    BITMAPINFO bmi = {};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = h;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    std::vector<DWORD> row(static_cast<size_t>(w));
    DWORD first = 0;
    bool haveFirst = false;
    bool uniform = true;

    const int sampleRows = 8;
    for (int i = 0; i < sampleRows && uniform; ++i)
    {
        const int y = (h - 1) * i / (sampleRows - 1);
        if (GetDIBits(hdc, hbmp, static_cast<UINT>(y), 1, row.data(), &bmi, DIB_RGB_COLORS) != 1)
        {
            // Can't sample — assume real content rather than a blank capture.
            uniform = false;
            break;
        }
        for (int x = 0; x < w; ++x)
        {
            const DWORD pixel = row[static_cast<size_t>(x)] & 0x00FFFFFF;
            if (!haveFirst)
            {
                first = pixel;
                haveFirst = true;
                continue;
            }
            if (pixel != first)
            {
                uniform = false;
                break;
            }
        }
    }

    ReleaseDC(NULL, hdc);
    return uniform && haveFirst;
}

// Capture a single window via PrintWindow. When `allowScreenFallback` is set
// and PrintWindow fails or renders a blank frame (common for GPU-composited
// apps), fall back to BitBlt-ing the window's rect straight from the screen
// DC — correct for the click-at-point path where the target window is on
// screen under the cursor. PID-based captures keep the fallback off because
// the target window may be occluded (typically by Stella itself).
static bool captureWindowBase64(HWND hwnd, std::string& outB64, int& ow, int& oh, bool allowScreenFallback)
{
    RECT rect = {};
    if (!GetWindowRect(hwnd, &rect)) return false;
    int w = rect.right - rect.left;
    int h = rect.bottom - rect.top;
    if (w <= 0 || h <= 0) return false;

    HDC hdcScreen = GetDC(NULL);
    if (!hdcScreen) return false;
    HDC hdcMem = CreateCompatibleDC(hdcScreen);
    HBITMAP hbmp = CreateCompatibleBitmap(hdcScreen, w, h);
    HGDIOBJ hOld = SelectObject(hdcMem, hbmp);

    // PW_RENDERFULLCONTENT (0x2) captures DWM-composited content; fall back to 0.
    BOOL ok = PrintWindow(hwnd, hdcMem, 2);
    if (!ok) ok = PrintWindow(hwnd, hdcMem, 0);

    // Deselect before sampling/encoding — GetDIBits needs the bitmap free.
    SelectObject(hdcMem, hOld);
    DeleteDC(hdcMem);
    ReleaseDC(NULL, hdcScreen);

    bool done = false;
    if (ok && !isBitmapUniform(hbmp, w, h))
    {
        done = encodeBitmapToJpegBase64(hbmp, outB64, ow, oh);
    }
    DeleteObject(hbmp);

    if (!done && allowScreenFallback)
    {
        return captureRegionBase64(rect.left, rect.top, w, h, outB64, ow, oh);
    }
    return done;
}

// Resolve the top-level window at a point (z-order walk, then WindowFromPoint
// fallback), honoring PID exclusion. Mirrors the one-shot main() resolution so
// the served --shot path picks the same window the host would.
static HWND resolveHwndAtPoint(POINT pt, const WindowExclusions& excluded)
{
    HWND hwnd = findTopLevelWindowAtPoint(pt, excluded);
    if (hwnd)
    {
        HWND root = GetAncestor(hwnd, GA_ROOT);
        if (root) hwnd = root;
        return hwnd;
    }

    hwnd = WindowFromPoint(pt);
    if (!hwnd) return NULL;
    HWND root = GetAncestor(hwnd, GA_ROOT);
    if (root) hwnd = root;
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd) || isWindowCloaked(hwnd)) return NULL;
    if (isWindowExcluded(hwnd, excluded)) return NULL;
    return hwnd;
}

// Topmost user-facing top-level window owned by `pid`. Mirrors the
// recent_apps alt-tab heuristic (visible, non-cloaked, root-owner, not a tool
// window) so the window captured for a recent-app chip is the same one the
// chip list surfaced. Prefers a non-minimized window; falls back to a
// minimized one (PrintWindow with PW_RENDERFULLCONTENT can often still render
// those via DWM).
static HWND findTopLevelWindowForPid(DWORD pid)
{
    HWND iconicFallback = NULL;
    for (HWND hwnd = GetTopWindow(NULL); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT))
    {
        DWORD windowPid = 0;
        GetWindowThreadProcessId(hwnd, &windowPid);
        if (windowPid != pid)
        {
            continue;
        }
        if (!IsWindowVisible(hwnd) || isWindowCloaked(hwnd))
        {
            continue;
        }
        if (GetAncestor(hwnd, GA_ROOTOWNER) != hwnd)
        {
            continue;
        }
        LONG exStyle = GetWindowLongA(hwnd, GWL_EXSTYLE);
        if (exStyle & WS_EX_TOOLWINDOW)
        {
            continue;
        }
        RECT rect = {};
        if (!GetWindowRect(hwnd, &rect) || rect.right <= rect.left || rect.bottom <= rect.top)
        {
            continue;
        }
        if (IsIconic(hwnd))
        {
            if (!iconicFallback) iconicFallback = hwnd;
            continue;
        }
        // GetTopWindow walks top-of-z-order first, so the first hit is the
        // process's topmost window.
        return hwnd;
    }
    return iconicFallback;
}

// `{title,process,pid,bounds,image,imageWidth,imageHeight}` for a resolved
// window, or an error object. Shared by the at-point and by-pid shot paths.
static std::string windowShotJsonForHwnd(HWND hwnd, bool allowScreenFallback)
{
    std::string b64;
    int iw = 0, ih = 0;
    if (!captureWindowBase64(hwnd, b64, iw, ih, allowScreenFallback)) return "{\"error\":\"capture failed\"}";

    std::string title = getWindowTitle(hwnd);
    RECT rect = {};
    GetWindowRect(hwnd, &rect);
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
    const char* exeName = processName;
    for (const char* p = processName; *p; ++p)
    {
        if (*p == '\\' || *p == '/') exeName = p + 1;
    }

    std::string out = "{\"title\":\"";
    out += escapeJson(title.c_str());
    out += "\",\"process\":\"";
    out += escapeJson(exeName);
    out += "\",\"pid\":";
    out += std::to_string(static_cast<unsigned long>(pid));
    out += ",\"bounds\":{\"x\":";
    out += std::to_string(static_cast<long>(rect.left));
    out += ",\"y\":";
    out += std::to_string(static_cast<long>(rect.top));
    out += ",\"width\":";
    out += std::to_string(rect.right - rect.left);
    out += ",\"height\":";
    out += std::to_string(rect.bottom - rect.top);
    out += "},\"image\":\"data:image/jpeg;base64,";
    out += b64;
    out += "\",\"imageWidth\":";
    out += std::to_string(iw);
    out += ",\"imageHeight\":";
    out += std::to_string(ih);
    out += "}";
    return out;
}

// Shot JSON for the window at a point. The window is on screen under the
// cursor, so the screen-DC fallback is enabled.
static std::string windowShotJsonAtPoint(POINT pt, const WindowExclusions& excluded)
{
    HWND hwnd = resolveHwndAtPoint(pt, excluded);
    if (!hwnd) return "{\"error\":\"no window at point\"}";
    return windowShotJsonForHwnd(hwnd, true);
}

// Shot JSON for a process's topmost window (recent-app chip lazy capture).
// No screen fallback: the target is usually occluded by Stella itself, so a
// screen BitBlt of its rect would capture the wrong content.
static std::string windowShotJsonForPid(DWORD pid)
{
    HWND hwnd = findTopLevelWindowForPid(pid);
    if (!hwnd) return "{\"error\":\"no window for pid\"}";
    return windowShotJsonForHwnd(hwnd, false);
}

// `{image,imageWidth,imageHeight}` for a virtual-screen rectangle.
static std::string regionShotJson(int x, int y, int w, int h)
{
    std::string b64;
    int iw = 0, ih = 0;
    if (!captureRegionBase64(x, y, w, h, b64, iw, ih)) return "{\"error\":\"capture failed\"}";

    std::string out = "{\"image\":\"data:image/jpeg;base64,";
    out += b64;
    out += "\",\"imageWidth\":";
    out += std::to_string(iw);
    out += ",\"imageHeight\":";
    out += std::to_string(ih);
    out += "}";
    return out;
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

// ── Persistent daemon mode ──────────────────────────────────────────────
// `window_info.exe --serve` keeps the process alive and answers many
// read-only point / batch queries over stdin/stdout, so the desktop avoids a
// CreateProcess (and its per-spawn Defender scan) for every hover/morph probe
// on Windows. Protocol is line-delimited:
//   request:  <id>\t<token>\t<token>...   (tokens mirror the one-shot CLI:
//                                           "<x> <y> [--exclude-pids=..]" or
//                                           "--points=x,y;.. [--exclude-pids=..]")
//   response: <id>\t<json>\n              (object, "null", or array — the same
//                                           shapes the one-shot helper prints)
// Read-only captures are also served: `--shot <x> <y>` returns the window at a
// point with an inline base64 JPEG, and `--region=x,y,w,h` returns a base64
// JPEG of a screen rect — both as single-line JSON (base64 has no tab/newline),
// so the composer capture paths cost a pipe write instead of a spawn. Only
// `--set-bounds` (which mutates window state) stays a one-shot spawn.
static std::string serveHandleTokens(const std::vector<std::string>& tokens)
{
    WindowExclusions excluded;
    std::vector<POINT> points;
    bool hasPoints = false;
    bool wantShot = false;
    DWORD shotPid = 0;
    long coords[2] = {0, 0};
    int coordCount = 0;

    for (const std::string& token : tokens)
    {
        if (token.empty())
        {
            continue;
        }
        const char* arg = token.c_str();
        // Region capture: `--region=x,y,w,h` → base64 JPEG of that screen rect.
        {
            int rx = 0, ry = 0, rw = 0, rh = 0;
            if (parseRegionArg(arg, rx, ry, rw, rh))
            {
                return regionShotJson(rx, ry, rw, rh);
            }
        }
        // Window capture: `--shot <x> <y>` (at point) or `--shot --pid=<pid>`.
        if (strcmp(arg, "--shot") == 0)
        {
            wantShot = true;
            continue;
        }
        if (parsePidArg(arg, shotPid))
        {
            continue;
        }
        if (strncmp(arg, "--points=", 9) == 0)
        {
            parsePointsArg(arg, points);
            hasPoints = true;
            continue;
        }
        if (strncmp(arg, "--exclude-pids=", 15) == 0)
        {
            parseExcludePidsArg(arg, excluded.pids);
            continue;
        }
        if (strncmp(arg, "--exclude-title-prefixes=", 25) == 0)
        {
            parseExcludeTitlePrefixesArg(arg, excluded.titlePrefixes);
            continue;
        }
        if (coordCount < 2)
        {
            char* end = nullptr;
            long value = strtol(arg, &end, 10);
            if (end != arg)
            {
                coords[coordCount++] = value;
            }
        }
    }

    if (wantShot)
    {
        if (shotPid != 0)
        {
            return windowShotJsonForPid(shotPid);
        }
        if (coordCount != 2)
        {
            return "{\"error\":\"bad request\"}";
        }
        POINT pt;
        pt.x = coords[0];
        pt.y = coords[1];
        return windowShotJsonAtPoint(pt, excluded);
    }

    if (hasPoints)
    {
        std::string out = "[";
        for (size_t i = 0; i < points.size(); ++i)
        {
            if (i)
            {
                out += ",";
            }
            out += windowInfoJsonAtPoint(points[i], excluded);
        }
        out += "]";
        return out;
    }

    if (coordCount == 2)
    {
        POINT pt;
        pt.x = coords[0];
        pt.y = coords[1];
        return windowInfoJsonAtPoint(pt, excluded);
    }

    return "{\"error\":\"bad request\"}";
}

static int runServeLoop()
{
    std::string line;
    while (std::getline(std::cin, line))
    {
        if (!line.empty() && line.back() == '\r')
        {
            line.pop_back();
        }
        if (line.empty())
        {
            continue;
        }

        const size_t tab = line.find('\t');
        if (tab == std::string::npos)
        {
            continue;
        }

        const std::string id = line.substr(0, tab);
        std::vector<std::string> tokens;
        size_t start = tab + 1;
        while (true)
        {
            const size_t next = line.find('\t', start);
            if (next == std::string::npos)
            {
                tokens.push_back(line.substr(start));
                break;
            }
            tokens.push_back(line.substr(start, next - start));
            start = next + 1;
        }

        const std::string json = serveHandleTokens(tokens);
        printf("%s\t%s\n", id.c_str(), json.c_str());
        fflush(stdout);
    }
    return 0;
}

int main(int argc, char* argv[])
{
    // Physical-pixel coordinates everywhere (see enableDpiAwareness). Must run
    // before any window/screen query so bounds and BitBlt rects are correct on
    // HiDPI; no-op at 100% scale.
    enableDpiAwareness();

    // Persistent daemon: serve point/batch queries over stdin/stdout instead
    // of one CreateProcess per call (Windows spawn + AV scan is the hot cost).
    if (argc >= 2 && strcmp(argv[1], "--serve") == 0)
    {
        return runServeLoop();
    }

    // One-shot region capture: `window_info --region=x,y,w,h` prints
    // `{image,imageWidth,imageHeight}`. Daemon-less fallback for the region
    // path so it never has to fall all the way back to desktopCapturer.
    for (int i = 1; i < argc; ++i)
    {
        int rx = 0, ry = 0, rw = 0, rh = 0;
        if (parseRegionArg(argv[i], rx, ry, rw, rh))
        {
            printf("%s\n", regionShotJson(rx, ry, rw, rh).c_str());
            return 0;
        }
    }

    // One-shot window capture: `window_info --shot <x> <y> [--exclude-pids=..]`
    // or `window_info --shot --pid=<pid>` prints
    // `{title,process,pid,bounds,image,...}`. Daemon-less fallback for the
    // window-click and recent-app-chip capture paths (no temp file, JPEG
    // base64 inline).
    if (argc >= 3 && strcmp(argv[1], "--shot") == 0)
    {
        DWORD shotPid = 0;
        WindowExclusions shotExcluded;
        long coords[2] = {0, 0};
        int coordCount = 0;
        for (int i = 2; i < argc; ++i)
        {
            if (parsePidArg(argv[i], shotPid))
            {
                continue;
            }
            parseExcludePidsArg(argv[i], shotExcluded.pids);
            parseExcludeTitlePrefixesArg(argv[i], shotExcluded.titlePrefixes);
            if (coordCount < 2)
            {
                char* end = nullptr;
                long value = strtol(argv[i], &end, 10);
                if (end != argv[i])
                {
                    coords[coordCount++] = value;
                }
            }
        }
        if (shotPid != 0)
        {
            printf("%s\n", windowShotJsonForPid(shotPid).c_str());
            return 0;
        }
        if (coordCount != 2)
        {
            fprintf(stderr, "Usage: window_info --shot <x> <y> | --shot --pid=<pid>\n");
            return 1;
        }
        POINT pt;
        pt.x = coords[0];
        pt.y = coords[1];
        printf("%s\n", windowShotJsonAtPoint(pt, shotExcluded).c_str());
        return 0;
    }

    // Batch mode: `window_info.exe --points=x1,y1;x2,y2;...` answers many
    // points from a single process invocation, printing a JSON array (one
    // entry per point in order; null when no window is found). Mirrors the
    // macOS helper's batch mode; used by the morph-visibility gate so a
    // transition probes N sample points with one spawn instead of N.
    {
        WindowExclusions batchExcluded;
        std::vector<POINT> batchPoints;
        bool hasPoints = false;
        for (int i = 1; i < argc; ++i)
        {
            parseExcludePidsArg(argv[i], batchExcluded.pids);
            parseExcludeTitlePrefixesArg(argv[i], batchExcluded.titlePrefixes);
            if (parsePointsArg(argv[i], batchPoints))
            {
                hasPoints = true;
            }
        }
        if (hasPoints)
        {
            std::string out = "[";
            for (size_t i = 0; i < batchPoints.size(); ++i)
            {
                if (i)
                {
                    out += ",";
                }
                out += windowInfoJsonAtPoint(batchPoints[i], batchExcluded);
            }
            out += "]";
            printf("%s\n", out.c_str());
            return 0;
        }
    }

    if (argc < 3)
    {
        fprintf(stderr, "Usage: window_info <x> <y>\n");
        return 1;
    }

    POINT pt;
    pt.x = atol(argv[1]);
    pt.y = atol(argv[2]);

    WindowExclusions excluded;
    const char* screenshotPath = nullptr;
    RECT setBounds = {};
    bool hasSetBounds = false;

    for (int i = 3; i < argc; ++i)
    {
        parseExcludePidsArg(argv[i], excluded.pids);
        parseExcludeTitlePrefixesArg(argv[i], excluded.titlePrefixes);
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

    HWND hwnd = findTopLevelWindowAtPoint(pt, excluded);
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

            if (hwnd)
            {
                if (isWindowExcluded(hwnd, excluded))
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
    std::string title = getWindowTitle(hwnd);

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
           escapeJson(title.c_str()).c_str(),
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
