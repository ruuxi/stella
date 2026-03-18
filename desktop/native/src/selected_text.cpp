// selected_text.exe - Get currently selected text via UI Automation
// Usage: selected_text.exe (no arguments)
// Output: Raw selected text to stdout (UTF-8), empty if nothing selected
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

// Try to extract selected text from a TextPattern on the given element.
// Returns true if text was found and written to stdout.
static bool tryGetSelection(IUIAutomationElement* el)
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
                            fwrite(utf8.c_str(), 1, utf8.size(), stdout);
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

int main()
{
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) return 0;

    IUIAutomation* uia = nullptr;
    hr = CoCreateInstance(__uuidof(CUIAutomation), NULL, CLSCTX_INPROC_SERVER,
                          __uuidof(IUIAutomation), (void**)&uia);
    if (FAILED(hr) || !uia)
    {
        CoUninitialize();
        return 0;
    }

    // Get the focused element
    IUIAutomationElement* focused = nullptr;
    hr = uia->GetFocusedElement(&focused);
    if (FAILED(hr) || !focused)
    {
        uia->Release();
        CoUninitialize();
        return 0;
    }

    // Walk up from focused element looking for a TextPattern with selection.
    // Browsers expose TextPattern on a parent document/pane element,
    // not on the directly focused leaf element.
    IUIAutomationTreeWalker* walker = nullptr;
    uia->get_RawViewWalker(&walker);

    IUIAutomationElement* current = focused;
    current->AddRef();

    for (int depth = 0; depth < 15 && current; depth++)
    {
        if (tryGetSelection(current))
        {
            current->Release();
            goto cleanup;
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

cleanup:
    if (walker) walker->Release();
    focused->Release();
    uia->Release();
    CoUninitialize();
    return 0;
}
