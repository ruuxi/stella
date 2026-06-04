// selected_text.exe - Get currently selected text + screen bounds via UI Automation
// Usage: selected_text.exe (no arguments)
// Output: A single line of JSON to stdout (UTF-8):
//   {"text":"...","rect":{"x":123,"y":456,"w":210,"h":22}}
//   {"text":"..."}                         (text but no bounds available)
//   {}                                     (nothing selected)
//
// Starts at FocusedElement and walks up the tree looking for a TextPattern
// with an active selection. This handles browsers where the TextPattern
// lives on a parent document/pane element rather than the focused leaf.
//
// Compile: cl /O2 /EHsc selected_text.cpp /link ole32.lib oleaut32.lib uuid.lib /OUT:selected_text.exe

#define NOMINMAX
#include <windows.h>
#include <UIAutomationClient.h>
#include <cstdio>
#include <cmath>
#include <cstring>
#include <cwchar>
#include <string>

static std::string toUtf8(const std::wstring& ws)
{
    if (ws.empty()) return "";
    int len = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), NULL, 0, NULL, NULL);
    if (len <= 0) return "";
    std::string s(len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), &s[0], len, NULL, NULL);
    return s;
}

// Encode a UTF-8 string as a JSON string literal (with surrounding quotes).
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
                    sprintf_s(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back((char)c);
                }
        }
    }
    out.push_back('"');
    return out;
}

struct RectBounds {
    bool valid;
    long x;
    long y;
    long w;
    long h;
};

// Compute the union of every rect returned by GetBoundingRectangles. The
// SAFEARRAY layout is [x0,y0,w0,h0, x1,y1,w1,h1, …] in screen pixels.
static RectBounds rectFromTextRange(IUIAutomationTextRange* range)
{
    RectBounds out{ false, 0, 0, 0, 0 };
    SAFEARRAY* sa = nullptr;
    if (FAILED(range->GetBoundingRectangles(&sa)) || !sa) return out;

    LONG lower = 0, upper = -1;
    if (FAILED(SafeArrayGetLBound(sa, 1, &lower)) ||
        FAILED(SafeArrayGetUBound(sa, 1, &upper))) {
        SafeArrayDestroy(sa);
        return out;
    }
    LONG total = upper - lower + 1;
    if (total < 4) {
        SafeArrayDestroy(sa);
        return out;
    }

    double* data = nullptr;
    if (FAILED(SafeArrayAccessData(sa, (void**)&data)) || !data) {
        SafeArrayDestroy(sa);
        return out;
    }

    double minX = 0, minY = 0, maxX = 0, maxY = 0;
    bool seeded = false;
    for (LONG i = 0; i + 3 < total; i += 4) {
        double x = data[i];
        double y = data[i + 1];
        double w = data[i + 2];
        double h = data[i + 3];
        if (w <= 0 || h <= 0) continue;
        if (!seeded) {
            minX = x; minY = y;
            maxX = x + w; maxY = y + h;
            seeded = true;
        } else {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x + w > maxX) maxX = x + w;
            if (y + h > maxY) maxY = y + h;
        }
    }
    SafeArrayUnaccessData(sa);
    SafeArrayDestroy(sa);

    if (!seeded) return out;
    out.valid = true;
    out.x = (long)std::lround(minX);
    out.y = (long)std::lround(minY);
    out.w = (long)std::lround(maxX - minX);
    out.h = (long)std::lround(maxY - minY);
    return out;
}

// Try to extract selected text from a TextPattern on the given element.
// On success, fills `outText` with the trimmed UTF-8 text and `outRect`
// with the screen bounds union (when available). Returns true if text
// was found.
static bool tryGetSelection(
    IUIAutomationElement* el,
    std::string& outText,
    RectBounds& outRect)
{
    IUnknown* patternUnk = nullptr;
    HRESULT hr = el->GetCurrentPattern(UIA_TextPatternId, &patternUnk);
    if (FAILED(hr) || !patternUnk) return false;

    IUIAutomationTextPattern* tp = nullptr;
    hr = patternUnk->QueryInterface(__uuidof(IUIAutomationTextPattern), (void**)&tp);
    patternUnk->Release();
    if (FAILED(hr) || !tp) return false;

    bool found = false;
    IUIAutomationTextRangeArray* ranges = nullptr;
    hr = tp->GetSelection(&ranges);
    if (SUCCEEDED(hr) && ranges)
    {
        int count = 0;
        ranges->get_Length(&count);
        if (count > 0)
        {
            IUIAutomationTextRange* range = nullptr;
            ranges->GetElement(0, &range);
            if (range)
            {
                BSTR text = nullptr;
                range->GetText(-1, &text);
                if (text)
                {
                    std::wstring ws(text, SysStringLen(text));
                    SysFreeString(text);

                    size_t start = ws.find_first_not_of(L" \t\r\n");
                    if (start != std::wstring::npos)
                    {
                        size_t end = ws.find_last_not_of(L" \t\r\n");
                        std::string utf8 = toUtf8(ws.substr(start, end - start + 1));
                        if (!utf8.empty())
                        {
                            outText = utf8;
                            outRect = rectFromTextRange(range);
                            found = true;
                        }
                    }
                }
                range->Release();
            }
        }
        ranges->Release();
    }

    tp->Release();
    return found;
}

static std::string buildEmpty()
{
    return "{}";
}

static std::string buildResult(const std::string& text, const RectBounds& rect)
{
    std::string out = "{\"text\":";
    out += jsonEscape(text);
    if (rect.valid) {
        char buf[128];
        int n = sprintf_s(
            buf, sizeof(buf),
            ",\"rect\":{\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld}}",
            rect.x, rect.y, rect.w, rect.h);
        if (n > 0) out.append(buf, (size_t)n);
        else out += "}";
    } else {
        out += "}";
    }
    return out;
}

// UI Automation pass: returns the JSON line if a selection was found, or an
// empty string when nothing was found. Every call here is a synchronous
// cross-process COM call into the focused app's UIA provider, which can block
// for a long time (Chromium/Electron build their accessibility tree lazily;
// games and unresponsive apps may never answer). It runs on a worker thread so
// the deadline in main() can bound it (see the watchdog there).
static std::string computeSelectionViaUia()
{
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) return "";

    IUIAutomation* uia = nullptr;
    hr = CoCreateInstance(__uuidof(CUIAutomation), NULL, CLSCTX_INPROC_SERVER,
                          __uuidof(IUIAutomation), (void**)&uia);
    if (FAILED(hr) || !uia)
    {
        CoUninitialize();
        return "";
    }

    // Get the focused element
    IUIAutomationElement* focused = nullptr;
    hr = uia->GetFocusedElement(&focused);
    if (FAILED(hr) || !focused)
    {
        uia->Release();
        CoUninitialize();
        return "";
    }

    // Walk up from focused element looking for a TextPattern with selection.
    // Browsers expose TextPattern on a parent document/pane element,
    // not on the directly focused leaf element.
    IUIAutomationTreeWalker* walker = nullptr;
    uia->get_RawViewWalker(&walker);

    IUIAutomationElement* current = focused;
    current->AddRef();

    std::string result;
    for (int depth = 0; depth < 15 && current; depth++)
    {
        std::string text;
        RectBounds rect{ false, 0, 0, 0, 0 };
        if (tryGetSelection(current, text, rect))
        {
            result = buildResult(text, rect);
            current->Release();
            current = nullptr;
            break;
        }

        IUIAutomationElement* parent = nullptr;
        if (walker)
        {
            walker->GetParentElement(current, &parent);
        }
        current->Release();
        current = parent;
    }

    if (current) current->Release();
    if (walker) walker->Release();
    focused->Release();
    uia->Release();
    CoUninitialize();
    return result;
}

// Ctrl+C means "interrupt", not "copy", in a console/terminal, so we must never
// inject it there. Detect the foreground window's class against the common
// console/terminal hosts and skip the clipboard fallback when it matches.
static bool isConsoleLikeForeground()
{
    HWND fg = GetForegroundWindow();
    if (!fg) return false;
    wchar_t cls[256] = {};
    if (GetClassNameW(fg, cls, 256) <= 0) return false;
    static const wchar_t* kConsoleClasses[] = {
        L"ConsoleWindowClass",            // conhost: cmd.exe, classic PowerShell
        L"CASCADIA_HOSTING_WINDOW_CLASS", // Windows Terminal
        L"VirtualConsoleClass",           // ConEmu / Cmder
        L"mintty",                        // Git Bash / Cygwin / MSYS2
        L"PuTTY",                         // PuTTY
    };
    for (const wchar_t* candidate : kConsoleClasses)
    {
        if (wcscmp(cls, candidate) == 0) return true;
    }
    return false;
}

static std::wstring readClipboardUnicode()
{
    std::wstring out;
    if (!OpenClipboard(NULL)) return out;
    HANDLE handle = GetClipboardData(CF_UNICODETEXT);
    if (handle)
    {
        const wchar_t* p = static_cast<const wchar_t*>(GlobalLock(handle));
        if (p)
        {
            out = p;
            GlobalUnlock(handle);
        }
    }
    CloseClipboard();
    return out;
}

static void setClipboardUnicode(const std::wstring& text)
{
    if (!OpenClipboard(NULL)) return;
    EmptyClipboard();
    const size_t bytes = (text.size() + 1) * sizeof(wchar_t);
    HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (mem)
    {
        void* dst = GlobalLock(mem);
        if (dst)
        {
            memcpy(dst, text.c_str(), bytes);
            GlobalUnlock(mem);
            // On success the system owns `mem`; only free it if the set failed.
            if (!SetClipboardData(CF_UNICODETEXT, mem)) GlobalFree(mem);
        }
        else
        {
            GlobalFree(mem);
        }
    }
    CloseClipboard();
}

static void clearClipboard()
{
    if (OpenClipboard(NULL))
    {
        EmptyClipboard();
        CloseClipboard();
    }
}

static void sendCtrlC()
{
    INPUT inputs[4] = {};
    inputs[0].type = INPUT_KEYBOARD; inputs[0].ki.wVk = VK_CONTROL;
    inputs[1].type = INPUT_KEYBOARD; inputs[1].ki.wVk = 'C';
    inputs[2].type = INPUT_KEYBOARD; inputs[2].ki.wVk = 'C';
    inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].type = INPUT_KEYBOARD; inputs[3].ki.wVk = VK_CONTROL;
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(4, inputs, sizeof(INPUT));
}

// Clipboard fallback for apps whose UIA provider doesn't expose a selection
// (Chromium/Electron, custom text views): synthesize Ctrl+C, read the copied
// text, then restore the prior clipboard. We only touch the clipboard if Ctrl+C
// actually changed it, so a no-op copy never clobbers an image/file already
// sitting on the clipboard. Prior non-text content can't be restored (we only
// snapshot text), which is an accepted trade-off. Returns the JSON line, or "".
static std::string getSelectionViaClipboard()
{
    const std::wstring saved = readClipboardUnicode();
    const bool hadText = !saved.empty();
    const DWORD seqBefore = GetClipboardSequenceNumber();

    sendCtrlC();

    std::wstring copied;
    bool changed = false;
    for (int i = 0; i < 50; i++) // up to ~500ms for the app to populate it
    {
        Sleep(10);
        if (GetClipboardSequenceNumber() != seqBefore)
        {
            changed = true;
            copied = readClipboardUnicode();
            break;
        }
    }

    if (!changed)
    {
        // Ctrl+C produced nothing (no selection / not copyable). Leave the
        // clipboard exactly as we found it.
        return "";
    }

    if (hadText) setClipboardUnicode(saved);
    else clearClipboard();

    const size_t start = copied.find_first_not_of(L" \t\r\n");
    if (start == std::wstring::npos) return "";
    const size_t end = copied.find_last_not_of(L" \t\r\n");
    const std::string utf8 = toUtf8(copied.substr(start, end - start + 1));
    if (utf8.empty()) return "";
    RectBounds noRect{ false, 0, 0, 0, 0 };
    return buildResult(utf8, noRect);
}

// UIA first (fast, side-effect-free). If it finds nothing and the clipboard
// fallback is allowed (and the foreground isn't a console), synthesize Ctrl+C.
static std::string computeSelectionJson(bool clipboardAllowed)
{
    std::string uia = computeSelectionViaUia();
    if (!uia.empty()) return uia;
    if (clipboardAllowed && !isConsoleLikeForeground())
    {
        std::string viaClipboard = getSelectionViaClipboard();
        if (!viaClipboard.empty()) return viaClipboard;
    }
    return buildEmpty();
}

// The worker thread fully populates g_result before signaling, so the main
// thread only ever reads it after WaitForSingleObject reports success.
static std::string g_result;
static HANDLE g_doneEvent = NULL;
static bool g_clipboardAllowed = true;

static DWORD WINAPI selectionWorker(LPVOID)
{
    g_result = computeSelectionJson(g_clipboardAllowed);
    SetEvent(g_doneEvent);
    return 0;
}

static void writeOut(const std::string& s)
{
    fwrite(s.data(), 1, s.size(), stdout);
    fflush(stdout);
}

int main(int argc, char* argv[])
{
    for (int i = 1; i < argc; i++)
    {
        if (strcmp(argv[i], "--no-clipboard-fallback") == 0)
        {
            g_clipboardAllowed = false;
        }
    }

    // Bound the work below the caller's process-kill timeout so we exit cleanly
    // with a result instead of hanging until we're SIGTERM'd (a killed spawn on
    // Windows costs a full process launch plus the kill-timeout wait, and this
    // runs after text selections). UIA-only is quick; the clipboard fallback
    // adds a synthetic Ctrl+C + clipboard poll, so it gets more headroom.
    const DWORD deadlineMs = g_clipboardAllowed ? 1500 : 700;

    g_doneEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
    HANDLE worker =
        g_doneEvent ? CreateThread(NULL, 0, selectionWorker, NULL, 0, NULL)
                    : NULL;

    // If we can't spin up the watchdog, fall back to running inline (no worse
    // than the previous, unbounded behavior).
    if (!g_doneEvent || !worker)
    {
        if (worker) CloseHandle(worker);
        if (g_doneEvent) CloseHandle(g_doneEvent);
        writeOut(computeSelectionJson(g_clipboardAllowed));
        return 0;
    }

    DWORD waited = WaitForSingleObject(g_doneEvent, deadlineMs);
    if (waited == WAIT_OBJECT_0)
    {
        writeOut(g_result);
        CloseHandle(worker);
        CloseHandle(g_doneEvent);
        return 0;
    }

    // Deadline hit: the work is stuck in the worker. Emit empty and hard-exit so
    // the blocked thread is torn down with the process rather than left hanging
    // until the parent's kill timeout.
    writeOut(buildEmpty());
    ExitProcess(0);
}
