// window_text.exe - Extract visible text from a window using UI Automation
// Usage: window_text.exe <pid> <x> <y>
// Output: Raw text to stdout (UTF-8), empty on failure
//
// Strategy:
// 1. Try TextPattern on the window (editors, document viewers)
// 2. FindAll descendants, collect bounding rects + text
// 3. Column-aware filter: find the content column under the cursor,
//    extract text from that column only (avoids sidebars, navbars, etc.)
// 4. Fallback: all elements with role filtering
//
// Compile: cl /O2 /EHsc window_text.cpp /link ole32.lib oleaut32.lib uuid.lib /OUT:window_text.exe

#define NOMINMAX
#include <windows.h>
#include <UIAutomationClient.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <set>
#include <algorithm>
#include <cmath>

static const int MAX_ELEMENTS = 2000;
static const int MIN_USEFUL_TEXT = 50;
static const int COLUMN_PAD = 60;
static const int MIN_COLUMN_WIDTH = 300;
static const int MAX_TEXT_OUTPUT = 32000;
static const int MIN_ANCHOR_AREA = 5000;

static bool isNoisyControlType(CONTROLTYPEID ctid)
{
    switch (ctid)
    {
    case UIA_MenuBarControlTypeId:
    case UIA_MenuControlTypeId:
    case UIA_MenuItemControlTypeId:
    case UIA_ToolBarControlTypeId:
    case UIA_StatusBarControlTypeId:
    case UIA_ScrollBarControlTypeId:
    case UIA_TitleBarControlTypeId:
    case UIA_ThumbControlTypeId:
        return true;
    default:
        return false;
    }
}

static std::wstring bstrToWstring(BSTR bstr)
{
    if (!bstr) return L"";
    return std::wstring(bstr, SysStringLen(bstr));
}

static std::string toUtf8(const std::wstring& ws)
{
    if (ws.empty()) return "";
    int len = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), NULL, 0, NULL, NULL);
    if (len <= 0) return "";
    std::string s(len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), &s[0], len, NULL, NULL);
    return s;
}

static std::wstring trimW(const std::wstring& s)
{
    size_t start = s.find_first_not_of(L" \t\r\n");
    if (start == std::wstring::npos) return L"";
    size_t end = s.find_last_not_of(L" \t\r\n");
    return s.substr(start, end - start + 1);
}

struct ElementInfo
{
    RECT rect;
    std::wstring name;
    std::wstring value;
};

static void outputText(const std::wstring& text)
{
    std::wstring t = trimW(text);
    if (t.empty()) return;
    if ((int)t.size() > MAX_TEXT_OUTPUT)
    {
        t = t.substr(0, MAX_TEXT_OUTPUT);
    }
    std::string utf8 = toUtf8(t);
    fwrite(utf8.c_str(), 1, utf8.size(), stdout);
}

int main(int argc, char* argv[])
{
    if (argc < 4)
    {
        return 1;
    }

    int targetPid = atoi(argv[1]);
    int cursorX = atoi(argv[2]);
    int cursorY = atoi(argv[3]);

    if (targetPid <= 0) return 1;

    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) return 1;

    IUIAutomation* uia = nullptr;
    hr = CoCreateInstance(__uuidof(CUIAutomation), NULL, CLSCTX_INPROC_SERVER,
                          __uuidof(IUIAutomation), (void**)&uia);
    if (FAILED(hr) || !uia)
    {
        CoUninitialize();
        return 1;
    }

    // Find window by PID
    IUIAutomationElement* root = nullptr;
    uia->GetRootElement(&root);
    if (!root)
    {
        uia->Release();
        CoUninitialize();
        return 1;
    }

    VARIANT pidVar;
    pidVar.vt = VT_I4;
    pidVar.lVal = targetPid;
    IUIAutomationCondition* pidCond = nullptr;
    uia->CreatePropertyCondition(UIA_ProcessIdPropertyId, pidVar, &pidCond);

    IUIAutomationElement* window = nullptr;
    root->FindFirst(TreeScope_Children, pidCond, &window);
    root->Release();
    pidCond->Release();

    if (!window)
    {
        uia->Release();
        CoUninitialize();
        return 1;
    }

    // --- Try TextPattern first (editors, document viewers) ---
    {
        IUnknown* patternUnk = nullptr;
        hr = window->GetCurrentPattern(UIA_TextPatternId, &patternUnk);
        if (SUCCEEDED(hr) && patternUnk)
        {
            IUIAutomationTextPattern* tp = nullptr;
            hr = patternUnk->QueryInterface(__uuidof(IUIAutomationTextPattern), (void**)&tp);
            patternUnk->Release();
            if (SUCCEEDED(hr) && tp)
            {
                IUIAutomationTextRange* range = nullptr;
                tp->get_DocumentRange(&range);
                if (range)
                {
                    BSTR text = nullptr;
                    range->GetText(MAX_TEXT_OUTPUT, &text);
                    if (text)
                    {
                        std::wstring ws = trimW(bstrToWstring(text));
                        SysFreeString(text);
                        if ((int)ws.size() >= MIN_USEFUL_TEXT)
                        {
                            outputText(ws);
                            range->Release();
                            tp->Release();
                            window->Release();
                            uia->Release();
                            CoUninitialize();
                            return 0;
                        }
                    }
                    range->Release();
                }
                tp->Release();
            }
        }
    }

    // --- FindAll Descendants ---
    IUIAutomationCondition* trueCond = nullptr;
    uia->CreateTrueCondition(&trueCond);

    IUIAutomationElementArray* allElements = nullptr;
    hr = window->FindAll(TreeScope_Descendants, trueCond, &allElements);
    trueCond->Release();
    window->Release();

    if (FAILED(hr) || !allElements)
    {
        uia->Release();
        CoUninitialize();
        return 1;
    }

    int totalCount = 0;
    allElements->get_Length(&totalCount);

    // Collect element data
    std::vector<ElementInfo> elements;
    elements.reserve(std::min(totalCount, MAX_ELEMENTS));

    for (int i = 0; i < totalCount && (int)elements.size() < MAX_ELEMENTS; i++)
    {
        IUIAutomationElement* el = nullptr;
        allElements->GetElement(i, &el);
        if (!el) continue;

        CONTROLTYPEID ctid = 0;
        el->get_CurrentControlType(&ctid);
        if (isNoisyControlType(ctid))
        {
            el->Release();
            continue;
        }

        RECT rect = {};
        hr = el->get_CurrentBoundingRectangle(&rect);
        if (FAILED(hr) || (rect.right <= rect.left && rect.bottom <= rect.top))
        {
            el->Release();
            continue;
        }

        BSTR nameBstr = nullptr;
        el->get_CurrentName(&nameBstr);
        std::wstring name = trimW(bstrToWstring(nameBstr));
        if (nameBstr) SysFreeString(nameBstr);

        std::wstring value;
        {
            IUnknown* vpUnk = nullptr;
            hr = el->GetCurrentPattern(UIA_ValuePatternId, &vpUnk);
            if (SUCCEEDED(hr) && vpUnk)
            {
                IUIAutomationValuePattern* vp = nullptr;
                hr = vpUnk->QueryInterface(__uuidof(IUIAutomationValuePattern), (void**)&vp);
                vpUnk->Release();
                if (SUCCEEDED(hr) && vp)
                {
                    BSTR valBstr = nullptr;
                    vp->get_CurrentValue(&valBstr);
                    value = trimW(bstrToWstring(valBstr));
                    if (valBstr) SysFreeString(valBstr);
                    vp->Release();
                }
            }
        }

        el->Release();
        elements.push_back({rect, name, value});
    }

    allElements->Release();
    uia->Release();
    CoUninitialize();

    if (elements.empty()) return 0;

    // --- Column-Aware Filtering ---

    // Find anchor: smallest area element containing cursor
    // Prefer elements with area >= MIN_ANCHOR_AREA (meaningful containers)
    int anchorIdx = -1;
    double minArea = 1e18;
    int smallAnchorIdx = -1;
    double smallMinArea = 1e18;

    for (int i = 0; i < (int)elements.size(); i++)
    {
        const auto& el = elements[i];
        if (cursorX >= el.rect.left && cursorX <= el.rect.right &&
            cursorY >= el.rect.top && cursorY <= el.rect.bottom)
        {
            double area = (double)(el.rect.right - el.rect.left) * (el.rect.bottom - el.rect.top);
            if (area > 0)
            {
                // Track smallest overall
                if (area < smallMinArea)
                {
                    smallMinArea = area;
                    smallAnchorIdx = i;
                }
                // Track smallest above threshold (prefer meaningful containers)
                if (area >= MIN_ANCHOR_AREA && area < minArea)
                {
                    minArea = area;
                    anchorIdx = i;
                }
            }
        }
    }

    // Fallback to absolute smallest if no container found
    if (anchorIdx < 0) anchorIdx = smallAnchorIdx;

    // If nothing contains cursor, find nearest element
    if (anchorIdx < 0)
    {
        double minDist = 1e18;
        for (int i = 0; i < (int)elements.size(); i++)
        {
            const auto& el = elements[i];
            double cx = (el.rect.left + el.rect.right) / 2.0;
            double cy = (el.rect.top + el.rect.bottom) / 2.0;
            double dist = (cx - cursorX) * (cx - cursorX) + (cy - cursorY) * (cy - cursorY);
            if (dist < minDist)
            {
                minDist = dist;
                anchorIdx = i;
            }
        }
    }

    // Define column band
    int colLeft = 0, colRight = 10000;
    if (anchorIdx >= 0)
    {
        const auto& anchor = elements[anchorIdx];
        colLeft = anchor.rect.left - COLUMN_PAD;
        colRight = anchor.rect.right + COLUMN_PAD;
        int colWidth = colRight - colLeft;
        if (colWidth < MIN_COLUMN_WIDTH)
        {
            int center = (colLeft + colRight) / 2;
            colLeft = center - MIN_COLUMN_WIDTH / 2;
            colRight = center + MIN_COLUMN_WIDTH / 2;
        }
    }

    // Collect text with deduplication
    auto collectText = [&](bool useColumnFilter) -> std::wstring
    {
        std::set<std::wstring> seen;
        std::wstring result;
        int count = 0;

        for (const auto& el : elements)
        {
            if (count >= 500) break;

            if (useColumnFilter)
            {
                // Element is "in column" if its horizontal range overlaps the column band
                if (el.rect.right < colLeft + 20 || el.rect.left > colRight - 20)
                    continue;
            }

            if (!el.name.empty() && seen.find(el.name) == seen.end())
            {
                seen.insert(el.name);
                if (!result.empty()) result += L"\n";
                result += el.name;
                count++;
            }
            if (!el.value.empty() && seen.find(el.value) == seen.end())
            {
                seen.insert(el.value);
                if (!result.empty()) result += L"\n";
                result += el.value;
                count++;
            }
        }

        return result;
    };

    // Pass 1: column-filtered
    std::wstring text = collectText(true);

    // Pass 2: fallback to all elements
    if ((int)text.size() < MIN_USEFUL_TEXT)
    {
        text = collectText(false);
    }

    outputText(text);
    return 0;
}
