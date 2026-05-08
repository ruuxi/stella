// stella-computer-helper.exe - Windows UI Automation + Win32 bridge for Stella.
// Usage: stella-computer-helper.exe <operation.json>

#define NOMINMAX
#include <windows.h>
#include <UIAutomationClient.h>
#include <gdiplus.h>
#include <objidl.h>
#include <shellapi.h>
#include <tlhelp32.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#pragma comment(lib, "gdiplus.lib")

struct ComInit {
    bool ok = false;
    ComInit() {
        HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
        ok = SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;
    }
    ~ComInit() {
        if (ok) CoUninitialize();
    }
};

template <typename T>
static void safeRelease(T*& ptr) {
    if (ptr) {
        ptr->Release();
        ptr = nullptr;
    }
}

static std::wstring toWide(const std::string& s) {
    if (s.empty()) return L"";
    int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), NULL, 0);
    if (len <= 0) return L"";
    std::wstring out(len, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], len);
    return out;
}

static std::string toUtf8(const std::wstring& ws) {
    if (ws.empty()) return "";
    int len = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), NULL, 0, NULL, NULL);
    if (len <= 0) return "";
    std::string out(len, '\0');
    WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), (int)ws.size(), &out[0], len, NULL, NULL);
    return out;
}

static std::wstring bstrToWstring(BSTR bstr) {
    if (!bstr) return L"";
    return std::wstring(bstr, SysStringLen(bstr));
}

static std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 16);
    for (unsigned char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
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
            break;
        }
    }
    return out;
}

static std::string jsonString(const std::string& s) {
    return "\"" + jsonEscape(s) + "\"";
}

struct Json {
    enum Type { Null, Bool, Number, String, Array, Object } type = Null;
    bool boolValue = false;
    double numberValue = 0;
    std::string stringValue;
    std::vector<Json> arrayValue;
    std::map<std::string, Json> objectValue;

    const Json* get(const std::string& key) const {
        if (type != Object) return nullptr;
        auto it = objectValue.find(key);
        return it == objectValue.end() ? nullptr : &it->second;
    }
    std::string str(const std::string& key, const std::string& fallback = "") const {
        const Json* value = get(key);
        return value && value->type == String ? value->stringValue : fallback;
    }
    double num(const std::string& key, double fallback = 0) const {
        const Json* value = get(key);
        return value && value->type == Number ? value->numberValue : fallback;
    }
};

struct JsonParser {
    const std::string& s;
    size_t i = 0;

    explicit JsonParser(const std::string& input) : s(input) {}

    void skipWs() {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++;
    }

    bool consume(char c) {
        skipWs();
        if (i < s.size() && s[i] == c) {
            i++;
            return true;
        }
        return false;
    }

    static void appendUtf8(std::string& out, unsigned codepoint) {
        if (codepoint <= 0x7f) {
            out.push_back((char)codepoint);
        } else if (codepoint <= 0x7ff) {
            out.push_back((char)(0xc0 | (codepoint >> 6)));
            out.push_back((char)(0x80 | (codepoint & 0x3f)));
        } else {
            out.push_back((char)(0xe0 | (codepoint >> 12)));
            out.push_back((char)(0x80 | ((codepoint >> 6) & 0x3f)));
            out.push_back((char)(0x80 | (codepoint & 0x3f)));
        }
    }

    std::string parseStringRaw() {
        std::string out;
        if (!consume('"')) return out;
        while (i < s.size()) {
            char c = s[i++];
            if (c == '"') break;
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            if (i >= s.size()) break;
            char esc = s[i++];
            switch (esc) {
            case '"': out.push_back('"'); break;
            case '\\': out.push_back('\\'); break;
            case '/': out.push_back('/'); break;
            case 'b': out.push_back('\b'); break;
            case 'f': out.push_back('\f'); break;
            case 'n': out.push_back('\n'); break;
            case 'r': out.push_back('\r'); break;
            case 't': out.push_back('\t'); break;
            case 'u': {
                unsigned cp = 0;
                for (int n = 0; n < 4 && i < s.size(); n++, i++) {
                    char h = s[i];
                    cp <<= 4;
                    if (h >= '0' && h <= '9') cp += h - '0';
                    else if (h >= 'a' && h <= 'f') cp += h - 'a' + 10;
                    else if (h >= 'A' && h <= 'F') cp += h - 'A' + 10;
                }
                appendUtf8(out, cp);
                break;
            }
            default:
                out.push_back(esc);
                break;
            }
        }
        return out;
    }

    Json parseValue() {
        skipWs();
        if (i >= s.size()) return {};
        if (s[i] == '"') {
            Json v;
            v.type = Json::String;
            v.stringValue = parseStringRaw();
            return v;
        }
        if (s[i] == '{') return parseObject();
        if (s[i] == '[') return parseArray();
        if (s.compare(i, 4, "true") == 0) {
            i += 4;
            Json v;
            v.type = Json::Bool;
            v.boolValue = true;
            return v;
        }
        if (s.compare(i, 5, "false") == 0) {
            i += 5;
            Json v;
            v.type = Json::Bool;
            return v;
        }
        if (s.compare(i, 4, "null") == 0) {
            i += 4;
            return {};
        }
        return parseNumber();
    }

    Json parseNumber() {
        skipWs();
        size_t start = i;
        if (i < s.size() && s[i] == '-') i++;
        while (i < s.size() && s[i] >= '0' && s[i] <= '9') i++;
        if (i < s.size() && s[i] == '.') {
            i++;
            while (i < s.size() && s[i] >= '0' && s[i] <= '9') i++;
        }
        if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
            i++;
            if (i < s.size() && (s[i] == '+' || s[i] == '-')) i++;
            while (i < s.size() && s[i] >= '0' && s[i] <= '9') i++;
        }
        Json v;
        v.type = Json::Number;
        v.numberValue = atof(s.substr(start, i - start).c_str());
        return v;
    }

    Json parseArray() {
        Json v;
        v.type = Json::Array;
        consume('[');
        skipWs();
        if (consume(']')) return v;
        while (i < s.size()) {
            v.arrayValue.push_back(parseValue());
            skipWs();
            if (consume(']')) break;
            consume(',');
        }
        return v;
    }

    Json parseObject() {
        Json v;
        v.type = Json::Object;
        consume('{');
        skipWs();
        if (consume('}')) return v;
        while (i < s.size()) {
            std::string key = parseStringRaw();
            consume(':');
            v.objectValue[key] = parseValue();
            skipWs();
            if (consume('}')) break;
            consume(',');
        }
        return v;
    }
};

struct Frame {
    double x = 0, y = 0, width = 0, height = 0;
    bool present = false;
};

struct ElementRecord {
    int index = -1;
    std::vector<int> runtimeId;
    std::wstring automationId;
    std::wstring name;
    std::wstring controlType;
    std::wstring localizedControlType;
    std::wstring className;
    std::wstring value;
    long long nativeWindowHandle = 0;
    Frame frame;
    std::vector<std::string> actions;
};

struct WindowProcess {
    HWND hwnd = NULL;
    DWORD pid = 0;
    std::wstring processName;
    std::wstring title;
};

struct Snapshot {
    std::wstring appName;
    DWORD pid = 0;
    std::wstring windowTitle;
    Frame windowBounds;
    std::string screenshotBase64;
    std::vector<std::string> treeLines;
    std::wstring focusedSummary;
    std::wstring selectedText;
    std::vector<ElementRecord> elements;
};

static bool envFlag(const char* name) {
    char buffer[32] = {};
    DWORD len = GetEnvironmentVariableA(name, buffer, sizeof(buffer));
    if (len == 0 || len >= sizeof(buffer)) return false;
    std::string v(buffer);
    std::transform(v.begin(), v.end(), v.begin(), ::tolower);
    return v == "1" || v == "true" || v == "yes" || v == "on";
}

static std::wstring lowerW(std::wstring value) {
    std::transform(value.begin(), value.end(), value.begin(), towlower);
    return value;
}

static std::wstring getWindowText(HWND hwnd) {
    int len = GetWindowTextLengthW(hwnd);
    if (len <= 0) return L"";
    std::wstring text(len + 1, L'\0');
    GetWindowTextW(hwnd, &text[0], len + 1);
    text.resize(wcslen(text.c_str()));
    return text;
}

static std::wstring baseNameFromPath(const std::wstring& path) {
    size_t slash = path.find_last_of(L"\\/");
    std::wstring name = slash == std::wstring::npos ? path : path.substr(slash + 1);
    if (name.size() > 4 && lowerW(name.substr(name.size() - 4)) == L".exe") {
        name.resize(name.size() - 4);
    }
    return name;
}

static std::wstring processNameForPid(DWORD pid) {
    std::wstring fallback;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W entry = {};
        entry.dwSize = sizeof(entry);
        if (Process32FirstW(snapshot, &entry)) {
            do {
                if (entry.th32ProcessID == pid) {
                    fallback = baseNameFromPath(entry.szExeFile);
                    break;
                }
            } while (Process32NextW(snapshot, &entry));
        }
        CloseHandle(snapshot);
    }

    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (process) {
        wchar_t path[MAX_PATH * 4] = {};
        DWORD size = (DWORD)(sizeof(path) / sizeof(path[0]));
        if (QueryFullProcessImageNameW(process, 0, path, &size)) {
            fallback = baseNameFromPath(path);
        }
        CloseHandle(process);
    }
    return fallback.empty() ? L"unknown" : fallback;
}

static BOOL CALLBACK enumWindowsProc(HWND hwnd, LPARAM lParam) {
    if (!IsWindowVisible(hwnd)) return TRUE;
    RECT rect = {};
    if (!GetWindowRect(hwnd, &rect) || rect.right <= rect.left || rect.bottom <= rect.top) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return TRUE;
    auto* out = reinterpret_cast<std::vector<WindowProcess>*>(lParam);
    WindowProcess item;
    item.hwnd = hwnd;
    item.pid = pid;
    item.title = getWindowText(hwnd);
    item.processName = processNameForPid(pid);
    out->push_back(item);
    return TRUE;
}

static std::vector<WindowProcess> listWindowProcesses() {
    std::vector<WindowProcess> windows;
    EnumWindows(enumWindowsProc, reinterpret_cast<LPARAM>(&windows));
    return windows;
}

static WindowProcess resolveApp(const std::wstring& query) {
    std::wstring normalized = query;
    std::wstring processQuery = normalized;
    if (processQuery.size() > 4 && lowerW(processQuery.substr(processQuery.size() - 4)) == L".exe") {
        processQuery.resize(processQuery.size() - 4);
    }
    std::wstring lowerQuery = lowerW(normalized);
    std::wstring lowerProcessQuery = lowerW(processQuery);
    DWORD pidQuery = (DWORD)_wtoi(normalized.c_str());

    std::vector<WindowProcess> windows = listWindowProcesses();
    for (const auto& win : windows) {
        if (pidQuery > 0 && win.pid == pidQuery) return win;
    }
    for (const auto& win : windows) {
        std::wstring name = lowerW(win.processName);
        std::wstring title = lowerW(win.title);
        if (name == lowerProcessQuery || name + L".exe" == lowerQuery || title == lowerQuery ||
            (!lowerQuery.empty() && title.find(lowerQuery) != std::wstring::npos)) {
            return win;
        }
    }

    if (envFlag("STELLA_COMPUTER_WINDOWS_ALLOW_APP_LAUNCH")) {
        SHELLEXECUTEINFOW info = {};
        info.cbSize = sizeof(info);
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpFile = normalized.c_str();
        info.nShow = SW_SHOWNORMAL;
        if (ShellExecuteExW(&info) && info.hProcess) {
            DWORD launchedPid = GetProcessId(info.hProcess);
            for (int i = 0; i < 20; i++) {
                Sleep(250);
                for (const auto& win : listWindowProcesses()) {
                    if (win.pid == launchedPid) {
                        CloseHandle(info.hProcess);
                        return win;
                    }
                }
            }
            CloseHandle(info.hProcess);
        }
    }

    throw std::runtime_error("appNotFound(\"" + toUtf8(query) + "\")");
}

static Frame frameFromRect(const RECT& rect) {
    Frame frame;
    frame.present = true;
    frame.x = rect.left;
    frame.y = rect.top;
    frame.width = rect.right - rect.left;
    frame.height = rect.bottom - rect.top;
    if (frame.width < 0 || frame.height < 0) frame.present = false;
    return frame;
}

static Frame windowBounds(HWND hwnd, IUIAutomationElement* element) {
    RECT rect = {};
    if (hwnd && GetWindowRect(hwnd, &rect)) {
        return frameFromRect(rect);
    }
    if (element) {
        HRESULT hr = element->get_CurrentBoundingRectangle(&rect);
        if (SUCCEEDED(hr)) return frameFromRect(rect);
    }
    return {};
}

static std::vector<int> runtimeIdVector(SAFEARRAY* runtime) {
    std::vector<int> values;
    if (!runtime) return values;
    LONG lower = 0, upper = -1;
    SafeArrayGetLBound(runtime, 1, &lower);
    SafeArrayGetUBound(runtime, 1, &upper);
    for (LONG i = lower; i <= upper; i++) {
        int value = 0;
        if (SUCCEEDED(SafeArrayGetElement(runtime, &i, &value))) values.push_back(value);
    }
    return values;
}

static std::vector<int> getRuntimeId(IUIAutomationElement* element) {
    SAFEARRAY* runtime = nullptr;
    std::vector<int> values;
    if (element && SUCCEEDED(element->GetRuntimeId(&runtime))) {
        values = runtimeIdVector(runtime);
    }
    if (runtime) SafeArrayDestroy(runtime);
    return values;
}

static std::wstring getBstrProperty(HRESULT (IUIAutomationElement::*getter)(BSTR*), IUIAutomationElement* element) {
    BSTR bstr = nullptr;
    std::wstring out;
    if (element && SUCCEEDED((element->*getter)(&bstr))) {
        out = bstrToWstring(bstr);
    }
    if (bstr) SysFreeString(bstr);
    return out;
}

static std::wstring controlTypeName(CONTROLTYPEID id) {
    switch (id) {
    case UIA_ButtonControlTypeId: return L"ControlType.Button";
    case UIA_CalendarControlTypeId: return L"ControlType.Calendar";
    case UIA_CheckBoxControlTypeId: return L"ControlType.CheckBox";
    case UIA_ComboBoxControlTypeId: return L"ControlType.ComboBox";
    case UIA_EditControlTypeId: return L"ControlType.Edit";
    case UIA_HyperlinkControlTypeId: return L"ControlType.Hyperlink";
    case UIA_ImageControlTypeId: return L"ControlType.Image";
    case UIA_ListItemControlTypeId: return L"ControlType.ListItem";
    case UIA_ListControlTypeId: return L"ControlType.List";
    case UIA_MenuControlTypeId: return L"ControlType.Menu";
    case UIA_MenuBarControlTypeId: return L"ControlType.MenuBar";
    case UIA_MenuItemControlTypeId: return L"ControlType.MenuItem";
    case UIA_ProgressBarControlTypeId: return L"ControlType.ProgressBar";
    case UIA_RadioButtonControlTypeId: return L"ControlType.RadioButton";
    case UIA_ScrollBarControlTypeId: return L"ControlType.ScrollBar";
    case UIA_SliderControlTypeId: return L"ControlType.Slider";
    case UIA_SpinnerControlTypeId: return L"ControlType.Spinner";
    case UIA_StatusBarControlTypeId: return L"ControlType.StatusBar";
    case UIA_TabControlTypeId: return L"ControlType.Tab";
    case UIA_TabItemControlTypeId: return L"ControlType.TabItem";
    case UIA_TextControlTypeId: return L"ControlType.Text";
    case UIA_ToolBarControlTypeId: return L"ControlType.ToolBar";
    case UIA_ToolTipControlTypeId: return L"ControlType.ToolTip";
    case UIA_TreeControlTypeId: return L"ControlType.Tree";
    case UIA_TreeItemControlTypeId: return L"ControlType.TreeItem";
    case UIA_CustomControlTypeId: return L"ControlType.Custom";
    case UIA_GroupControlTypeId: return L"ControlType.Group";
    case UIA_ThumbControlTypeId: return L"ControlType.Thumb";
    case UIA_DataGridControlTypeId: return L"ControlType.DataGrid";
    case UIA_DataItemControlTypeId: return L"ControlType.DataItem";
    case UIA_DocumentControlTypeId: return L"ControlType.Document";
    case UIA_SplitButtonControlTypeId: return L"ControlType.SplitButton";
    case UIA_WindowControlTypeId: return L"ControlType.Window";
    case UIA_PaneControlTypeId: return L"ControlType.Pane";
    case UIA_HeaderControlTypeId: return L"ControlType.Header";
    case UIA_HeaderItemControlTypeId: return L"ControlType.HeaderItem";
    case UIA_TableControlTypeId: return L"ControlType.Table";
    case UIA_TitleBarControlTypeId: return L"ControlType.TitleBar";
    case UIA_SeparatorControlTypeId: return L"ControlType.Separator";
    default: return L"ControlType." + std::to_wstring(id);
    }
}

template <typename T>
static T* getPattern(IUIAutomationElement* element, PATTERNID patternId) {
    if (!element) return nullptr;
    T* pattern = nullptr;
    HRESULT hr = element->GetCurrentPatternAs(patternId, __uuidof(T), reinterpret_cast<void**>(&pattern));
    return SUCCEEDED(hr) ? pattern : nullptr;
}

static std::wstring getElementValue(IUIAutomationElement* element) {
    IUIAutomationValuePattern* value = getPattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
    std::wstring out;
    if (value) {
        BSTR bstr = nullptr;
        if (SUCCEEDED(value->get_CurrentValue(&bstr))) out = bstrToWstring(bstr);
        if (bstr) SysFreeString(bstr);
        value->Release();
    }
    if (out.size() > 500) out.resize(500);
    return out;
}

static std::vector<std::string> getPatternNames(IUIAutomationElement* element) {
    std::vector<std::string> names;
    if (!element) return names;
    IUIAutomationInvokePattern* invoke = getPattern<IUIAutomationInvokePattern>(element, UIA_InvokePatternId);
    if (invoke) {
        names.push_back("Invoke");
        invoke->Release();
    }
    IUIAutomationTogglePattern* toggle = getPattern<IUIAutomationTogglePattern>(element, UIA_TogglePatternId);
    if (toggle) {
        names.push_back("Toggle");
        toggle->Release();
    }
    IUIAutomationSelectionItemPattern* selection = getPattern<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId);
    if (selection) {
        names.push_back("Select");
        selection->Release();
    }
    IUIAutomationExpandCollapsePattern* expand = getPattern<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId);
    if (expand) {
        ExpandCollapseState state = ExpandCollapseState_LeafNode;
        if (SUCCEEDED(expand->get_CurrentExpandCollapseState(&state))) {
            if (state == ExpandCollapseState_Expanded) names.push_back("Collapse");
            else if (state == ExpandCollapseState_Collapsed) names.push_back("Expand");
            else {
                names.push_back("Expand");
                names.push_back("Collapse");
            }
        } else {
            names.push_back("Expand");
            names.push_back("Collapse");
        }
        expand->Release();
    }
    IUIAutomationScrollItemPattern* scrollItem = getPattern<IUIAutomationScrollItemPattern>(element, UIA_ScrollItemPatternId);
    if (scrollItem) {
        names.push_back("ScrollIntoView");
        scrollItem->Release();
    }
    IUIAutomationScrollPattern* scroll = getPattern<IUIAutomationScrollPattern>(element, UIA_ScrollPatternId);
    if (scroll) {
        names.push_back("Scroll");
        scroll->Release();
    }
    IUIAutomationValuePattern* value = getPattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
    if (value) {
        names.push_back("SetValue");
        value->Release();
    }
    std::sort(names.begin(), names.end());
    names.erase(std::unique(names.begin(), names.end()), names.end());
    return names;
}

static ElementRecord elementRecord(IUIAutomationElement* element, int index, const Frame& windowFrame) {
    ElementRecord record;
    record.index = index;
    record.runtimeId = getRuntimeId(element);
    record.automationId = getBstrProperty(&IUIAutomationElement::get_CurrentAutomationId, element);
    record.name = getBstrProperty(&IUIAutomationElement::get_CurrentName, element);
    record.localizedControlType = getBstrProperty(&IUIAutomationElement::get_CurrentLocalizedControlType, element);
    record.className = getBstrProperty(&IUIAutomationElement::get_CurrentClassName, element);
    record.value = getElementValue(element);
    CONTROLTYPEID ctid = 0;
    if (SUCCEEDED(element->get_CurrentControlType(&ctid))) record.controlType = controlTypeName(ctid);
    UIA_HWND handle = NULL;
    if (SUCCEEDED(element->get_CurrentNativeWindowHandle(&handle))) {
        record.nativeWindowHandle = (long long)(intptr_t)handle;
    }
    RECT rect = {};
    if (SUCCEEDED(element->get_CurrentBoundingRectangle(&rect))) {
        Frame absolute = frameFromRect(rect);
        if (absolute.present) {
            record.frame = absolute;
            if (windowFrame.present) {
                record.frame.x -= windowFrame.x;
                record.frame.y -= windowFrame.y;
            }
        }
    }
    record.actions = getPatternNames(element);
    return record;
}

static std::wstring elementTitle(const ElementRecord& record) {
    if (!record.name.empty()) return record.name;
    if (!record.automationId.empty()) return L"ID: " + record.automationId;
    return L"";
}

static std::string frameJson(const Frame& frame) {
    if (!frame.present) return "null";
    std::ostringstream out;
    out << "{\"x\":" << frame.x << ",\"y\":" << frame.y << ",\"width\":" << frame.width
        << ",\"height\":" << frame.height << "}";
    return out.str();
}

static void renderTreeVisit(IUIAutomation* uia, IUIAutomationElement* node, int depth, const Frame& windowFrame,
                            std::set<std::string>& visited, std::vector<ElementRecord>& records,
                            std::vector<std::string>& lines) {
    if (!node || records.size() >= 500 || depth > 16) return;
    std::vector<int> runtime = getRuntimeId(node);
    std::ostringstream key;
    for (int value : runtime) key << value << ".";
    std::string runtimeKey = key.str();
    if (runtimeKey.empty()) runtimeKey = std::to_string((uintptr_t)node);
    if (!visited.insert(runtimeKey).second) return;

    int index = (int)records.size();
    ElementRecord record = elementRecord(node, index, windowFrame);
    records.push_back(record);

    std::wstring role = !record.localizedControlType.empty() ? record.localizedControlType : record.controlType;
    std::wstring title = elementTitle(record);
    std::string line((depth + 1), '\t');
    line += std::to_string(index) + " " + toUtf8(role) + " " + toUtf8(title);
    if (!record.value.empty() && record.value != title) {
        std::string value = toUtf8(record.value);
        std::replace(value.begin(), value.end(), '\r', ' ');
        std::replace(value.begin(), value.end(), '\n', ' ');
        line += " Value: " + value;
    }
    if (!record.actions.empty()) {
        line += " Secondary Actions: ";
        for (size_t i = 0; i < record.actions.size(); i++) {
            if (i) line += ", ";
            line += record.actions[i];
        }
    }
    if (record.frame.present) {
        line += " Frame: {x: " + std::to_string((int)std::round(record.frame.x)) +
            ", y: " + std::to_string((int)std::round(record.frame.y)) +
            ", width: " + std::to_string((int)std::round(record.frame.width)) +
            ", height: " + std::to_string((int)std::round(record.frame.height)) + "}";
    }
    lines.push_back(line);

    IUIAutomationCondition* condition = nullptr;
    IUIAutomationElementArray* children = nullptr;
    if (SUCCEEDED(uia->CreateTrueCondition(&condition)) &&
        SUCCEEDED(node->FindAll(TreeScope_Children, condition, &children)) && children) {
        int length = 0;
        children->get_Length(&length);
        for (int i = 0; i < length; i++) {
            IUIAutomationElement* child = nullptr;
            if (SUCCEEDED(children->GetElement(i, &child))) {
                renderTreeVisit(uia, child, depth + 1, windowFrame, visited, records, lines);
            }
            safeRelease(child);
        }
    }
    safeRelease(children);
    safeRelease(condition);
}

static int pngEncoderClsid(CLSID* clsid) {
    UINT num = 0, size = 0;
    Gdiplus::GetImageEncodersSize(&num, &size);
    if (!size) return -1;
    std::vector<BYTE> buffer(size);
    Gdiplus::ImageCodecInfo* codecs = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buffer.data());
    Gdiplus::GetImageEncoders(num, size, codecs);
    for (UINT i = 0; i < num; i++) {
        if (wcscmp(codecs[i].MimeType, L"image/png") == 0) {
            *clsid = codecs[i].Clsid;
            return (int)i;
        }
    }
    return -1;
}

static std::string base64Encode(const std::vector<BYTE>& bytes) {
    static const char* table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((bytes.size() + 2) / 3) * 4);
    for (size_t i = 0; i < bytes.size(); i += 3) {
        unsigned value = bytes[i] << 16;
        if (i + 1 < bytes.size()) value |= bytes[i + 1] << 8;
        if (i + 2 < bytes.size()) value |= bytes[i + 2];
        out.push_back(table[(value >> 18) & 63]);
        out.push_back(table[(value >> 12) & 63]);
        out.push_back(i + 1 < bytes.size() ? table[(value >> 6) & 63] : '=');
        out.push_back(i + 2 < bytes.size() ? table[value & 63] : '=');
    }
    return out;
}

static std::string captureWindowPngBase64(const Frame& bounds) {
    if (!bounds.present || bounds.width <= 0 || bounds.height <= 0) return "";
    int width = std::max(1, (int)std::round(bounds.width));
    int height = std::max(1, (int)std::round(bounds.height));
    HDC screen = GetDC(NULL);
    HDC mem = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, width, height);
    HGDIOBJ old = SelectObject(mem, bitmap);
    BOOL ok = BitBlt(mem, 0, 0, width, height, screen, (int)std::round(bounds.x), (int)std::round(bounds.y), SRCCOPY | CAPTUREBLT);

    std::string out;
    if (ok) {
        Gdiplus::Bitmap gdipBitmap(bitmap, NULL);
        CLSID clsid = {};
        IStream* stream = nullptr;
        if (pngEncoderClsid(&clsid) >= 0 && SUCCEEDED(CreateStreamOnHGlobal(NULL, TRUE, &stream))) {
            if (gdipBitmap.Save(stream, &clsid, NULL) == Gdiplus::Ok) {
                STATSTG stat = {};
                if (SUCCEEDED(stream->Stat(&stat, STATFLAG_NONAME))) {
                    LARGE_INTEGER zero = {};
                    stream->Seek(zero, STREAM_SEEK_SET, NULL);
                    std::vector<BYTE> bytes((size_t)stat.cbSize.QuadPart);
                    ULONG read = 0;
                    if (SUCCEEDED(stream->Read(bytes.data(), (ULONG)bytes.size(), &read))) {
                        bytes.resize(read);
                        out = base64Encode(bytes);
                    }
                }
            }
        }
        safeRelease(stream);
    }

    SelectObject(mem, old);
    DeleteObject(bitmap);
    DeleteDC(mem);
    ReleaseDC(NULL, screen);
    return out;
}

static std::wstring focusedSummary(IUIAutomation* uia, DWORD pid) {
    IUIAutomationElement* focused = nullptr;
    std::wstring out;
    if (SUCCEEDED(uia->GetFocusedElement(&focused)) && focused) {
        int focusedPid = 0;
        if (SUCCEEDED(focused->get_CurrentProcessId(&focusedPid)) && (DWORD)focusedPid == pid) {
            std::wstring role = getBstrProperty(&IUIAutomationElement::get_CurrentLocalizedControlType, focused);
            std::wstring name = getBstrProperty(&IUIAutomationElement::get_CurrentName, focused);
            out = name.empty() ? role : role + L" " + name;
        }
    }
    safeRelease(focused);
    return out;
}

static std::wstring selectedText(IUIAutomation* uia, DWORD pid) {
    IUIAutomationElement* focused = nullptr;
    std::wstring out;
    if (FAILED(uia->GetFocusedElement(&focused)) || !focused) return out;
    int focusedPid = 0;
    if (FAILED(focused->get_CurrentProcessId(&focusedPid)) || (DWORD)focusedPid != pid) {
        safeRelease(focused);
        return out;
    }
    IUIAutomationTextPattern* text = getPattern<IUIAutomationTextPattern>(focused, UIA_TextPatternId);
    if (text) {
        IUIAutomationTextRangeArray* ranges = nullptr;
        if (SUCCEEDED(text->GetSelection(&ranges)) && ranges) {
            int length = 0;
            ranges->get_Length(&length);
            if (length > 0) {
                IUIAutomationTextRange* range = nullptr;
                if (SUCCEEDED(ranges->GetElement(0, &range)) && range) {
                    BSTR bstr = nullptr;
                    if (SUCCEEDED(range->GetText(2048, &bstr))) out = bstrToWstring(bstr);
                    if (bstr) SysFreeString(bstr);
                }
                safeRelease(range);
            }
        }
        safeRelease(ranges);
    }
    safeRelease(text);
    safeRelease(focused);
    return out;
}

static Snapshot buildSnapshot(IUIAutomation* uia, const std::wstring& query) {
    WindowProcess process = resolveApp(query);
    IUIAutomationElement* root = nullptr;
    HRESULT hr = uia->ElementFromHandle(process.hwnd, &root);
    if (FAILED(hr) || !root) {
        throw std::runtime_error("No top-level UI Automation window is available for " + toUtf8(process.processName));
    }
    Snapshot snapshot;
    snapshot.appName = process.processName;
    snapshot.pid = process.pid;
    snapshot.windowTitle = process.title;
    snapshot.windowBounds = windowBounds(process.hwnd, root);
    std::set<std::string> visited;
    renderTreeVisit(uia, root, 0, snapshot.windowBounds, visited, snapshot.elements, snapshot.treeLines);
    snapshot.screenshotBase64 = captureWindowPngBase64(snapshot.windowBounds);
    snapshot.focusedSummary = focusedSummary(uia, process.pid);
    snapshot.selectedText = selectedText(uia, process.pid);
    safeRelease(root);
    return snapshot;
}

static std::vector<int> parseRuntimeId(const Json* element) {
    std::vector<int> out;
    if (!element) return out;
    const Json* runtime = element->get("runtimeId");
    if (!runtime || runtime->type != Json::Array) return out;
    for (const Json& value : runtime->arrayValue) {
        if (value.type == Json::Number) out.push_back((int)value.numberValue);
    }
    return out;
}

static Frame parseFrame(const Json* element) {
    Frame frame;
    if (!element) return frame;
    const Json* f = element->get("frame");
    if (!f || f->type != Json::Object) return frame;
    frame.present = true;
    frame.x = f->num("x");
    frame.y = f->num("y");
    frame.width = f->num("width");
    frame.height = f->num("height");
    return frame;
}

static bool sameRuntimeId(const std::vector<int>& left, const std::vector<int>& right) {
    return !left.empty() && left == right;
}

static void collectAllElements(IUIAutomation* uia, IUIAutomationElement* root, std::vector<IUIAutomationElement*>& out) {
    if (!root) return;
    root->AddRef();
    out.push_back(root);
    IUIAutomationCondition* condition = nullptr;
    IUIAutomationElementArray* descendants = nullptr;
    if (SUCCEEDED(uia->CreateTrueCondition(&condition)) &&
        SUCCEEDED(root->FindAll(TreeScope_Descendants, condition, &descendants)) && descendants) {
        int length = 0;
        descendants->get_Length(&length);
        for (int i = 0; i < length; i++) {
            IUIAutomationElement* element = nullptr;
            if (SUCCEEDED(descendants->GetElement(i, &element)) && element) out.push_back(element);
        }
    }
    safeRelease(descendants);
    safeRelease(condition);
}

static IUIAutomationElement* findElement(IUIAutomation* uia, IUIAutomationElement* root, const Json* recordJson) {
    if (!recordJson || recordJson->type != Json::Object) return nullptr;
    std::vector<int> wantedRuntime = parseRuntimeId(recordJson);
    std::wstring wantedAutomationId = toWide(recordJson->str("automationId"));
    std::wstring wantedName = toWide(recordJson->str("name"));
    std::wstring wantedType = toWide(recordJson->str("controlType"));
    std::vector<IUIAutomationElement*> all;
    collectAllElements(uia, root, all);
    for (IUIAutomationElement* element : all) {
        if (sameRuntimeId(getRuntimeId(element), wantedRuntime)) {
            for (IUIAutomationElement* other : all) if (other != element) other->Release();
            return element;
        }
    }
    for (IUIAutomationElement* element : all) {
        std::wstring automationId = getBstrProperty(&IUIAutomationElement::get_CurrentAutomationId, element);
        std::wstring name = getBstrProperty(&IUIAutomationElement::get_CurrentName, element);
        CONTROLTYPEID ctid = 0;
        std::wstring type;
        if (SUCCEEDED(element->get_CurrentControlType(&ctid))) type = controlTypeName(ctid);
        if (((!wantedAutomationId.empty() && wantedAutomationId == automationId) ||
             (!wantedName.empty() && wantedName == name)) &&
            wantedType == type) {
            for (IUIAutomationElement* other : all) if (other != element) other->Release();
            return element;
        }
    }
    for (IUIAutomationElement* element : all) element->Release();
    return nullptr;
}

static POINT screenPointFromFrame(const Frame& local, const Frame& window) {
    POINT p = {};
    p.x = (LONG)std::round(window.x + local.x + local.width / 2.0);
    p.y = (LONG)std::round(window.y + local.y + local.height / 2.0);
    return p;
}

static LPARAM toLParam(int x, int y) {
    return (LPARAM)(((y & 0xffff) << 16) | (x & 0xffff));
}

static WPARAM toWheelWParam(int delta) {
    return (WPARAM)((delta & 0xffff) << 16);
}

static bool withinRoot(HWND root, HWND child) {
    return child && (root == child || IsChild(root, child) || GetAncestor(child, GA_ROOT) == root);
}

static HWND deepestChildFromPoint(HWND root, POINT screen) {
    HWND current = root;
    for (int depth = 0; depth < 16; depth++) {
        POINT client = screen;
        ScreenToClient(current, &client);
        HWND child = ChildWindowFromPointEx(current, client, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT);
        if (!child || child == current || !withinRoot(root, child)) return current;
        current = child;
    }
    return current;
}

static HWND resolveMessageTarget(HWND root, POINT screen, POINT* clientOut) {
    HWND target = deepestChildFromPoint(root, screen);
    *clientOut = screen;
    ScreenToClient(target, clientOut);
    return target;
}

static void sendMouseClick(HWND hwnd, POINT screen, const std::string& button, int count) {
    POINT client = {};
    HWND target = resolveMessageTarget(hwnd, screen, &client);
    UINT down = WM_LBUTTONDOWN, up = WM_LBUTTONUP;
    WPARAM downFlag = MK_LBUTTON;
    if (button == "right") {
        down = WM_RBUTTONDOWN;
        up = WM_RBUTTONUP;
        downFlag = MK_RBUTTON;
    } else if (button == "middle") {
        down = WM_MBUTTONDOWN;
        up = WM_MBUTTONUP;
        downFlag = MK_MBUTTON;
    }
    LPARAM lp = toLParam(client.x, client.y);
    for (int i = 0; i < std::max(1, count); i++) {
        PostMessageW(target, WM_MOUSEMOVE, 0, lp);
        PostMessageW(target, down, downFlag, lp);
        Sleep(35);
        PostMessageW(target, up, 0, lp);
        Sleep(50);
    }
}

static void sendDrag(HWND hwnd, POINT from, POINT to) {
    POINT start = {};
    HWND target = resolveMessageTarget(hwnd, from, &start);
    POINT end = to;
    ScreenToClient(target, &end);
    LPARAM startParam = toLParam(start.x, start.y);
    PostMessageW(target, WM_MOUSEMOVE, 0, startParam);
    PostMessageW(target, WM_LBUTTONDOWN, MK_LBUTTON, startParam);
    for (int i = 1; i <= 12; i++) {
        int x = (int)std::round(start.x + (end.x - start.x) * i / 12.0);
        int y = (int)std::round(start.y + (end.y - start.y) * i / 12.0);
        PostMessageW(target, WM_MOUSEMOVE, MK_LBUTTON, toLParam(x, y));
        Sleep(20);
    }
    PostMessageW(target, WM_LBUTTONUP, 0, toLParam(end.x, end.y));
}

static void sendScroll(HWND hwnd, POINT screen, const std::string& direction, double pages) {
    POINT client = {};
    HWND target = resolveMessageTarget(hwnd, screen, &client);
    int delta = (int)std::round(120 * pages);
    UINT message = WM_MOUSEWHEEL;
    if (direction == "down" || direction == "right") delta *= -1;
    if (direction == "left" || direction == "right") message = WM_MOUSEHWHEEL;
    PostMessageW(target, message, toWheelWParam(delta), toLParam(client.x, client.y));
}

static void sendText(HWND hwnd, const std::wstring& text) {
    for (wchar_t ch : text) {
        PostMessageW(hwnd, WM_CHAR, (WPARAM)ch, 0);
        Sleep(8);
    }
}

static bool sendTextToEditHandle(HWND hwnd, const std::wstring& text, IUIAutomationElement* element) {
    if (!hwnd) return false;
    if (SendMessageW(hwnd, EM_SETSEL, (WPARAM)-1, (LPARAM)-1) >= 0) {
        SendMessageW(hwnd, EM_REPLACESEL, TRUE, (LPARAM)text.c_str());
        return true;
    }
    std::wstring current = element ? getElementValue(element) : L"";
    return SendMessageW(hwnd, WM_SETTEXT, 0, (LPARAM)(current + text).c_str()) != 0;
}

static int virtualKey(const std::string& key) {
    std::string k = key;
    std::transform(k.begin(), k.end(), k.begin(), ::tolower);
    static const std::map<std::string, int> keys = {
        {"return", VK_RETURN}, {"enter", VK_RETURN}, {"tab", VK_TAB}, {"escape", VK_ESCAPE}, {"esc", VK_ESCAPE},
        {"backspace", VK_BACK}, {"back_space", VK_BACK}, {"delete", VK_DELETE}, {"space", VK_SPACE},
        {"left", VK_LEFT}, {"up", VK_UP}, {"right", VK_RIGHT}, {"down", VK_DOWN},
        {"home", VK_HOME}, {"end", VK_END}, {"page_up", VK_PRIOR}, {"prior", VK_PRIOR},
        {"page_down", VK_NEXT}, {"next", VK_NEXT}
    };
    auto it = keys.find(k);
    if (it != keys.end()) return it->second;
    if (k.size() >= 2 && k[0] == 'f') {
        int n = atoi(k.c_str() + 1);
        if (n >= 1 && n <= 12) return VK_F1 + n - 1;
    }
    if (k.size() == 4 && k.substr(0, 3) == "kp_" && k[3] >= '0' && k[3] <= '9') return VK_NUMPAD0 + (k[3] - '0');
    if (k.size() == 1) {
        char c = (char)toupper(k[0]);
        if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z')) return c;
    }
    throw std::runtime_error("Unsupported key: " + key);
}

static void sendKey(HWND hwnd, const std::string& key) {
    std::vector<std::string> parts;
    std::string current;
    for (char c : key) {
        if (c == '+') {
            if (!current.empty()) parts.push_back(current);
            current.clear();
        } else {
            current.push_back(c);
        }
    }
    if (!current.empty()) parts.push_back(current);
    if (parts.empty()) throw std::runtime_error("press_key requires a key.");
    std::vector<int> modifiers;
    for (size_t i = 0; i + 1 < parts.size(); i++) {
        std::string m = parts[i];
        std::transform(m.begin(), m.end(), m.begin(), ::tolower);
        if (m == "ctrl" || m == "control") modifiers.push_back(VK_CONTROL);
        else if (m == "shift") modifiers.push_back(VK_SHIFT);
        else if (m == "alt") modifiers.push_back(VK_MENU);
        else if (m == "super" || m == "win" || m == "cmd") modifiers.push_back(VK_LWIN);
    }
    for (int mod : modifiers) PostMessageW(hwnd, WM_KEYDOWN, mod, 0);
    int vk = virtualKey(parts.back());
    PostMessageW(hwnd, WM_KEYDOWN, vk, 0);
    Sleep(25);
    PostMessageW(hwnd, WM_KEYUP, vk, 0);
    std::reverse(modifiers.begin(), modifiers.end());
    for (int mod : modifiers) PostMessageW(hwnd, WM_KEYUP, mod, 0);
}

static bool invokePreferredClick(IUIAutomationElement* element) {
    IUIAutomationInvokePattern* invoke = getPattern<IUIAutomationInvokePattern>(element, UIA_InvokePatternId);
    if (invoke) {
        HRESULT hr = invoke->Invoke();
        invoke->Release();
        if (SUCCEEDED(hr)) return true;
    }
    IUIAutomationSelectionItemPattern* select = getPattern<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId);
    if (select) {
        HRESULT hr = select->Select();
        select->Release();
        if (SUCCEEDED(hr)) return true;
    }
    IUIAutomationTogglePattern* toggle = getPattern<IUIAutomationTogglePattern>(element, UIA_TogglePatternId);
    if (toggle) {
        HRESULT hr = toggle->Toggle();
        toggle->Release();
        if (SUCCEEDED(hr)) return true;
    }
    return false;
}

static void invokeSecondaryAction(IUIAutomationElement* element, const std::string& action, int index) {
    std::string lower = action;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    if (lower == "invoke") {
        IUIAutomationInvokePattern* pattern = getPattern<IUIAutomationInvokePattern>(element, UIA_InvokePatternId);
        if (pattern) { HRESULT hr = pattern->Invoke(); pattern->Release(); if (SUCCEEDED(hr)) return; }
    } else if (lower == "toggle") {
        IUIAutomationTogglePattern* pattern = getPattern<IUIAutomationTogglePattern>(element, UIA_TogglePatternId);
        if (pattern) { HRESULT hr = pattern->Toggle(); pattern->Release(); if (SUCCEEDED(hr)) return; }
    } else if (lower == "select") {
        IUIAutomationSelectionItemPattern* pattern = getPattern<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId);
        if (pattern) { HRESULT hr = pattern->Select(); pattern->Release(); if (SUCCEEDED(hr)) return; }
    } else if (lower == "expand" || lower == "collapse") {
        IUIAutomationExpandCollapsePattern* pattern = getPattern<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId);
        if (pattern) {
            HRESULT hr = lower == "expand" ? pattern->Expand() : pattern->Collapse();
            pattern->Release();
            if (SUCCEEDED(hr)) return;
        }
    } else if (lower == "scrollintoview") {
        IUIAutomationScrollItemPattern* pattern = getPattern<IUIAutomationScrollItemPattern>(element, UIA_ScrollItemPatternId);
        if (pattern) { HRESULT hr = pattern->ScrollIntoView(); pattern->Release(); if (SUCCEEDED(hr)) return; }
    } else if (lower == "setfocus") {
        if (!envFlag("STELLA_COMPUTER_WINDOWS_ALLOW_FOCUS_ACTIONS")) {
            throw std::runtime_error("SetFocus is disabled by default to avoid stealing user focus; set STELLA_COMPUTER_WINDOWS_ALLOW_FOCUS_ACTIONS=1 to enable it.");
        }
        HRESULT hr = element->SetFocus();
        if (SUCCEEDED(hr)) return;
    }
    throw std::runtime_error(action + " is not a valid secondary action for " + std::to_string(index));
}

static bool invokeScroll(IUIAutomationElement* element, const std::string& direction, double pages) {
    IUIAutomationScrollPattern* scroll = getPattern<IUIAutomationScrollPattern>(element, UIA_ScrollPatternId);
    if (!scroll) return false;
    ScrollAmount horizontal = ScrollAmount_NoAmount;
    ScrollAmount vertical = ScrollAmount_NoAmount;
    if (direction == "up") vertical = ScrollAmount_LargeDecrement;
    else if (direction == "down") vertical = ScrollAmount_LargeIncrement;
    else if (direction == "left") horizontal = ScrollAmount_LargeDecrement;
    else if (direction == "right") horizontal = ScrollAmount_LargeIncrement;
    int repeat = std::max(1, (int)std::ceil(pages));
    bool ok = true;
    for (int i = 0; i < repeat; i++) {
        ok = SUCCEEDED(scroll->Scroll(horizontal, vertical)) && ok;
        Sleep(40);
    }
    scroll->Release();
    return ok;
}

static bool isTextCandidate(HWND rootHwnd, IUIAutomationElement* element) {
    if (!element) return false;
    UIA_HWND native = NULL;
    if (FAILED(element->get_CurrentNativeWindowHandle(&native)) || native == 0 || (HWND)(intptr_t)native == rootHwnd) return false;
    std::wstring control = controlTypeName([&] { CONTROLTYPEID c = 0; element->get_CurrentControlType(&c); return c; }());
    std::wstring cls = getBstrProperty(&IUIAutomationElement::get_CurrentClassName, element);
    std::wstring hay = lowerW(control + L" " + cls);
    return hay.find(L"edit") != std::wstring::npos || hay.find(L"document") != std::wstring::npos ||
           hay.find(L"rich") != std::wstring::npos || hay.find(L"text") != std::wstring::npos;
}

static IUIAutomationElement* findTextEntryElement(IUIAutomation* uia, IUIAutomationElement* root, DWORD pid) {
    IUIAutomationElement* focused = nullptr;
    if (SUCCEEDED(uia->GetFocusedElement(&focused)) && focused) {
        int focusedPid = 0;
        if (SUCCEEDED(focused->get_CurrentProcessId(&focusedPid)) && (DWORD)focusedPid == pid) {
            IUIAutomationValuePattern* value = getPattern<IUIAutomationValuePattern>(focused, UIA_ValuePatternId);
            BOOL readOnly = TRUE;
            if (value && SUCCEEDED(value->get_CurrentIsReadOnly(&readOnly)) && !readOnly) {
                value->Release();
                return focused;
            }
            safeRelease(value);
        }
    }
    safeRelease(focused);

    std::vector<IUIAutomationElement*> all;
    collectAllElements(uia, root, all);
    IUIAutomationElement* candidate = nullptr;
    for (IUIAutomationElement* element : all) {
        IUIAutomationValuePattern* value = getPattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
        BOOL readOnly = TRUE;
        bool writable = value && SUCCEEDED(value->get_CurrentIsReadOnly(&readOnly)) && !readOnly;
        safeRelease(value);
        CONTROLTYPEID ctid = 0;
        element->get_CurrentControlType(&ctid);
        if (writable && (ctid == UIA_EditControlTypeId || ctid == UIA_DocumentControlTypeId)) {
            candidate = element;
            break;
        }
    }
    if (!candidate) {
        for (IUIAutomationElement* element : all) {
            IUIAutomationValuePattern* value = getPattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
            BOOL readOnly = TRUE;
            bool writable = value && SUCCEEDED(value->get_CurrentIsReadOnly(&readOnly)) && !readOnly;
            safeRelease(value);
            if (writable) {
                candidate = element;
                break;
            }
        }
    }
    for (IUIAutomationElement* element : all) if (element != candidate) element->Release();
    return candidate;
}

static HWND findTextEntryWindowHandle(IUIAutomation* uia, IUIAutomationElement* root, HWND rootHwnd, IUIAutomationElement* preferred) {
    if (isTextCandidate(rootHwnd, preferred)) {
        UIA_HWND native = NULL;
        preferred->get_CurrentNativeWindowHandle(&native);
        return (HWND)(intptr_t)native;
    }
    std::vector<IUIAutomationElement*> all;
    collectAllElements(uia, root, all);
    HWND hwnd = NULL;
    for (IUIAutomationElement* element : all) {
        if (!isTextCandidate(rootHwnd, element)) continue;
        UIA_HWND native = NULL;
        element->get_CurrentNativeWindowHandle(&native);
        hwnd = (HWND)(intptr_t)native;
        break;
    }
    for (IUIAutomationElement* element : all) element->Release();
    return hwnd;
}

static bool invokeTypeText(IUIAutomation* uia, IUIAutomationElement* root, const WindowProcess& process, const std::wstring& text) {
    IUIAutomationElement* element = findTextEntryElement(uia, root, process.pid);
    HWND target = findTextEntryWindowHandle(uia, root, process.hwnd, element);
    if (target && sendTextToEditHandle(target, text, element)) {
        safeRelease(element);
        return true;
    }
    if (element) {
        IUIAutomationValuePattern* value = getPattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
        BOOL readOnly = TRUE;
        if (value && SUCCEEDED(value->get_CurrentIsReadOnly(&readOnly)) && !readOnly) {
            if (!envFlag("STELLA_COMPUTER_WINDOWS_ALLOW_UIA_TEXT_FALLBACK")) {
                safeRelease(value);
                safeRelease(element);
                throw std::runtime_error("UIA ValuePattern text fallback is disabled by default because it may bring the target app to the foreground; set STELLA_COMPUTER_WINDOWS_ALLOW_UIA_TEXT_FALLBACK=1 to enable it.");
            }
            std::wstring current = getElementValue(element);
            std::wstring combined = current + text;
            BSTR next = SysAllocString(combined.c_str());
            HRESULT hr = value->SetValue(next);
            SysFreeString(next);
            safeRelease(value);
            safeRelease(element);
            return SUCCEEDED(hr);
        }
        safeRelease(value);
    }
    safeRelease(element);
    return false;
}

struct ActionProbe {
    bool cursorKnown = false;
    POINT cursor = {};
    long long foreground = 0;
};

static ActionProbe captureProbe() {
    ActionProbe probe;
    probe.cursorKnown = !!GetCursorPos(&probe.cursor);
    probe.foreground = (long long)GetForegroundWindow();
    return probe;
}

static std::string receiptJson(const ActionProbe& before, const std::string& route) {
    POINT after = {};
    bool afterKnown = !!GetCursorPos(&after);
    bool cursorMoved = !before.cursorKnown || !afterKnown || before.cursor.x != after.x || before.cursor.y != after.y;
    bool foregroundChanged = before.foreground != (long long)GetForegroundWindow();
    std::ostringstream out;
    out << "{\"ok\":true,\"route\":" << jsonString(route)
        << ",\"lane\":\"same_session\",\"background_safe\":" << ((!cursorMoved && !foregroundChanged) ? "true" : "false")
        << ",\"cursor_moved\":" << (cursorMoved ? "true" : "false")
        << ",\"foreground_changed\":" << (foregroundChanged ? "true" : "false")
        << ",\"session\":\"parent\"}";
    return out.str();
}

static std::string elementJson(const ElementRecord& record) {
    std::ostringstream out;
    out << "{\"index\":" << record.index << ",\"runtimeId\":[";
    for (size_t i = 0; i < record.runtimeId.size(); i++) {
        if (i) out << ",";
        out << record.runtimeId[i];
    }
    out << "],\"automationId\":" << jsonString(toUtf8(record.automationId))
        << ",\"name\":" << jsonString(toUtf8(record.name))
        << ",\"controlType\":" << jsonString(toUtf8(record.controlType))
        << ",\"localizedControlType\":" << jsonString(toUtf8(record.localizedControlType))
        << ",\"className\":" << jsonString(toUtf8(record.className))
        << ",\"value\":" << jsonString(toUtf8(record.value))
        << ",\"nativeWindowHandle\":" << record.nativeWindowHandle
        << ",\"frame\":" << frameJson(record.frame)
        << ",\"actions\":[";
    for (size_t i = 0; i < record.actions.size(); i++) {
        if (i) out << ",";
        out << jsonString(record.actions[i]);
    }
    out << "]}";
    return out.str();
}

static std::string snapshotJson(const Snapshot& snapshot) {
    std::ostringstream out;
    out << "{\"app\":{\"name\":" << jsonString(toUtf8(snapshot.appName))
        << ",\"bundleIdentifier\":" << jsonString(toUtf8(snapshot.appName))
        << ",\"pid\":" << snapshot.pid << "},\"windowTitle\":" << jsonString(toUtf8(snapshot.windowTitle))
        << ",\"windowBounds\":" << frameJson(snapshot.windowBounds)
        << ",\"screenshotPngBase64\":";
    if (snapshot.screenshotBase64.empty()) out << "null";
    else out << jsonString(snapshot.screenshotBase64);
    out << ",\"treeLines\":[";
    for (size_t i = 0; i < snapshot.treeLines.size(); i++) {
        if (i) out << ",";
        out << jsonString(snapshot.treeLines[i]);
    }
    out << "],\"focusedSummary\":";
    if (snapshot.focusedSummary.empty()) out << "null";
    else out << jsonString(toUtf8(snapshot.focusedSummary));
    out << ",\"selectedText\":";
    if (snapshot.selectedText.empty()) out << "null";
    else out << jsonString(toUtf8(snapshot.selectedText));
    out << ",\"elements\":[";
    for (size_t i = 0; i < snapshot.elements.size(); i++) {
        if (i) out << ",";
        out << elementJson(snapshot.elements[i]);
    }
    out << "]}";
    return out.str();
}

static std::string listAppsText() {
    std::vector<WindowProcess> windows = listWindowProcesses();
    std::sort(windows.begin(), windows.end(), [](const WindowProcess& a, const WindowProcess& b) {
        if (lowerW(a.processName) == lowerW(b.processName)) return a.pid < b.pid;
        return lowerW(a.processName) < lowerW(b.processName);
    });
    std::ostringstream out;
    for (size_t i = 0; i < windows.size(); i++) {
        if (i) out << "\n";
        std::string title = toUtf8(windows[i].title.empty() ? L"untitled" : windows[i].title);
        std::string name = toUtf8(windows[i].processName);
        out << name << " -- " << name << " [running, pid=" << windows[i].pid << ", window=" << title << "]";
    }
    return out.str();
}

static std::string failJson(const std::string& error) {
    return "{\"ok\":false,\"error\":" + jsonString(error) + "}";
}

static std::string okSnapshotJson(const Snapshot& snapshot) {
    return "{\"ok\":true,\"snapshot\":" + snapshotJson(snapshot) + "}";
}

static int operationElementIndex(const Json& operation) {
    const Json* element = operation.get("element");
    return element ? (int)element->num("index", -1) : -1;
}

static std::string executeOperation(IUIAutomation* uia, const Json& operation) {
    std::string tool = operation.str("tool");
    if (tool == "list_apps") {
        return "{\"ok\":true,\"text\":" + jsonString(listAppsText()) + "}";
    }
    std::wstring app = toWide(operation.str("app"));
    if (tool == "get_app_state") {
        return okSnapshotJson(buildSnapshot(uia, app));
    }

    WindowProcess process = resolveApp(app);
    IUIAutomationElement* root = nullptr;
    if (FAILED(uia->ElementFromHandle(process.hwnd, &root)) || !root) {
        throw std::runtime_error("No top-level UI Automation window is available for " + toUtf8(process.processName));
    }
    const Json* elementJsonValue = operation.get("element");
    IUIAutomationElement* element = findElement(uia, root, elementJsonValue);
    Frame windowFrame = parseFrame(&operation);
    const Json* wb = operation.get("windowBounds");
    if (wb && wb->type == Json::Object) {
        windowFrame.present = true;
        windowFrame.x = wb->num("x");
        windowFrame.y = wb->num("y");
        windowFrame.width = wb->num("width");
        windowFrame.height = wb->num("height");
    } else {
        windowFrame = windowBounds(process.hwnd, root);
    }
    ActionProbe probe = captureProbe();
    std::string route = "unknown";

    if (tool == "click") {
        std::string button = operation.str("mouse_button", "left");
        bool handled = false;
        if (element && button != "right" && button != "middle") {
            handled = invokePreferredClick(element);
            if (handled) route = "uia.pattern.click";
        }
        if (!handled) {
            POINT point = {};
            Frame elementFrame = parseFrame(elementJsonValue);
            if (elementFrame.present && windowFrame.present) {
                point = screenPointFromFrame(elementFrame, windowFrame);
            } else {
                point.x = (LONG)std::round(windowFrame.x + operation.num("x"));
                point.y = (LONG)std::round(windowFrame.y + operation.num("y"));
            }
            sendMouseClick(process.hwnd, point, button, (int)operation.num("click_count", 1));
            route = "hwnd.postmessage.click";
        }
    } else if (tool == "perform_secondary_action") {
        if (!element) throw std::runtime_error("unknown element_index '" + std::to_string(operationElementIndex(operation)) + "'");
        std::string action = operation.str("action");
        invokeSecondaryAction(element, action, operationElementIndex(operation));
        route = "uia.secondary_action." + action;
    } else if (tool == "scroll") {
        std::string direction = operation.str("direction", "down");
        double pages = operation.num("pages", 1);
        bool handled = element && invokeScroll(element, direction, pages);
        if (handled) {
            route = "uia.scroll";
        } else {
            Frame elementFrame = parseFrame(elementJsonValue);
            POINT point = elementFrame.present ? screenPointFromFrame(elementFrame, windowFrame)
                                               : POINT{(LONG)std::round(windowFrame.x + windowFrame.width / 2), (LONG)std::round(windowFrame.y + windowFrame.height / 2)};
            sendScroll(process.hwnd, point, direction, pages);
            route = "hwnd.postmessage.scroll";
        }
    } else if (tool == "drag") {
        POINT from = {(LONG)std::round(windowFrame.x + operation.num("from_x")), (LONG)std::round(windowFrame.y + operation.num("from_y"))};
        POINT to = {(LONG)std::round(windowFrame.x + operation.num("to_x")), (LONG)std::round(windowFrame.y + operation.num("to_y"))};
        sendDrag(process.hwnd, from, to);
        route = "hwnd.postmessage.drag";
    } else if (tool == "type_text") {
        std::wstring text = toWide(operation.str("text"));
        if (invokeTypeText(uia, root, process, text)) route = "uia_or_hwnd.text_target";
        else {
            sendText(process.hwnd, text);
            route = "hwnd.postmessage.text";
        }
    } else if (tool == "press_key") {
        sendKey(process.hwnd, operation.str("key"));
        route = "hwnd.postmessage.key";
    } else if (tool == "set_value") {
        if (!element) throw std::runtime_error("unknown element_index '" + std::to_string(operationElementIndex(operation)) + "'");
        IUIAutomationValuePattern* value = getPattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
        if (!value) throw std::runtime_error("Cannot set a value for an element that is not settable");
        std::wstring next = toWide(operation.str("value"));
        BSTR bstr = SysAllocString(next.c_str());
        HRESULT hr = value->SetValue(bstr);
        SysFreeString(bstr);
        value->Release();
        if (FAILED(hr)) throw std::runtime_error("Cannot set a value for an element that is not settable");
        route = "uia.value.set";
    } else {
        throw std::runtime_error("unsupportedTool(\"" + tool + "\")");
    }

    Sleep(120);
    Snapshot refreshed = buildSnapshot(uia, app);
    std::string response = "{\"ok\":true,\"receipt\":" + receiptJson(probe, route) + ",\"snapshot\":" + snapshotJson(refreshed) + "}";
    safeRelease(element);
    safeRelease(root);
    return response;
}

int main(int argc, char** argv) {
    SetConsoleOutputCP(CP_UTF8);
    if (argc != 2) {
        printf("%s\n", failJson("Usage: stella-computer-helper.exe <operation.json>").c_str());
        return 0;
    }

    ComInit com;
    if (!com.ok) {
        printf("%s\n", failJson("COM initialization failed").c_str());
        return 0;
    }

    ULONG_PTR gdiplusToken = 0;
    Gdiplus::GdiplusStartupInput gdiplusInput;
    Gdiplus::GdiplusStartup(&gdiplusToken, &gdiplusInput, NULL);

    IUIAutomation* uia = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(CUIAutomation), NULL, CLSCTX_INPROC_SERVER,
                                  __uuidof(IUIAutomation), reinterpret_cast<void**>(&uia));
    if (FAILED(hr) || !uia) {
        if (gdiplusToken) Gdiplus::GdiplusShutdown(gdiplusToken);
        printf("%s\n", failJson("UI Automation initialization failed").c_str());
        return 0;
    }

    try {
        std::ifstream input(argv[1], std::ios::binary);
        std::stringstream buffer;
        buffer << input.rdbuf();
        JsonParser parser(buffer.str());
        Json operation = parser.parseValue();
        std::string response = executeOperation(uia, operation);
        fwrite(response.c_str(), 1, response.size(), stdout);
        fwrite("\n", 1, 1, stdout);
    } catch (const std::exception& error) {
        std::string response = failJson(error.what());
        fwrite(response.c_str(), 1, response.size(), stdout);
        fwrite("\n", 1, 1, stdout);
    }

    safeRelease(uia);
    if (gdiplusToken) Gdiplus::GdiplusShutdown(gdiplusToken);
    return 0;
}
