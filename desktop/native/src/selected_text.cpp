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

static void emitEmpty()
{
    fwrite("{}", 1, 2, stdout);
}

static void emit(const std::string& text, const RectBounds& rect)
{
    std::string textLiteral = jsonEscape(text);
    if (rect.valid) {
        char buf[128];
        int n = sprintf_s(
            buf, sizeof(buf),
            ",\"rect\":{\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld}}",
            rect.x, rect.y, rect.w, rect.h);
        fwrite("{\"text\":", 1, 8, stdout);
        fwrite(textLiteral.data(), 1, textLiteral.size(), stdout);
        if (n > 0) fwrite(buf, 1, (size_t)n, stdout);
    } else {
        fwrite("{\"text\":", 1, 8, stdout);
        fwrite(textLiteral.data(), 1, textLiteral.size(), stdout);
        fwrite("}", 1, 1, stdout);
    }
}

int main()
{
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) { emitEmpty(); return 0; }

    IUIAutomation* uia = nullptr;
    hr = CoCreateInstance(__uuidof(CUIAutomation), NULL, CLSCTX_INPROC_SERVER,
                          __uuidof(IUIAutomation), (void**)&uia);
    if (FAILED(hr) || !uia)
    {
        CoUninitialize();
        emitEmpty();
        return 0;
    }

    // Get the focused element
    IUIAutomationElement* focused = nullptr;
    hr = uia->GetFocusedElement(&focused);
    if (FAILED(hr) || !focused)
    {
        uia->Release();
        CoUninitialize();
        emitEmpty();
        return 0;
    }

    // Walk up from focused element looking for a TextPattern with selection.
    // Browsers expose TextPattern on a parent document/pane element,
    // not on the directly focused leaf element.
    IUIAutomationTreeWalker* walker = nullptr;
    uia->get_RawViewWalker(&walker);

    IUIAutomationElement* current = focused;
    current->AddRef();

    bool emitted = false;
    for (int depth = 0; depth < 15 && current; depth++)
    {
        std::string text;
        RectBounds rect{ false, 0, 0, 0, 0 };
        if (tryGetSelection(current, text, rect))
        {
            emit(text, rect);
            emitted = true;
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
    if (!emitted) emitEmpty();

    if (walker) walker->Release();
    focused->Release();
    uia->Release();
    CoUninitialize();
    return 0;
}
