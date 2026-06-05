// stella-computer-helper.exe - Windows UI Automation + Win32 bridge for Stella.
// Usage: stella-computer-helper.exe <operation.json>

#define NOMINMAX
#include <windows.h>
#include <UIAutomationClient.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <objidl.h>
#include <shellapi.h>
#include <shobjidl.h>
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
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "dwmapi.lib")

#ifndef PW_RENDERFULLCONTENT
#define PW_RENDERFULLCONTENT 0x00000002
#endif

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
    long long windowId = 0;
    std::wstring windowTitle;
    Frame windowBounds;
    std::string screenshotBase64;
    std::vector<std::string> treeLines;
    std::wstring focusedSummary;
    std::wstring selectedText;
    std::vector<ElementRecord> elements;
    std::vector<std::string> warnings;
    std::string captureMethod;
    bool captureOccluded = false;
};

static const int postActionSettleMs = 120;

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

static long long hwndValue(HWND hwnd) {
    return (long long)(uintptr_t)hwnd;
}

static HWND hwndFromValue(long long value) {
    return (HWND)(uintptr_t)value;
}

static long long parseHwndTarget(const std::wstring& query) {
    std::wstring lower = lowerW(query);
    const std::wstring prefix = L"hwnd:";
    if (lower.rfind(prefix, 0) != 0) return 0;
    wchar_t* end = nullptr;
    unsigned long long value = wcstoull(lower.c_str() + prefix.size(), &end, 10);
    return value > 0 ? (long long)value : 0;
}

static std::wstring classNameForWindow(HWND hwnd);

static DWORD integrityRidForProcess(DWORD pid) {
    HANDLE process = pid == GetCurrentProcessId()
        ? GetCurrentProcess()
        : OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return 0;

    HANDLE token = NULL;
    DWORD rid = 0;
    if (OpenProcessToken(process, TOKEN_QUERY, &token)) {
        DWORD bytes = 0;
        GetTokenInformation(token, TokenIntegrityLevel, NULL, 0, &bytes);
        if (bytes > 0) {
            std::vector<BYTE> buffer(bytes);
            if (GetTokenInformation(token, TokenIntegrityLevel, buffer.data(), bytes, &bytes)) {
                TOKEN_MANDATORY_LABEL* label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(buffer.data());
                DWORD count = *GetSidSubAuthorityCount(label->Label.Sid);
                rid = *GetSidSubAuthority(label->Label.Sid, count - 1);
            }
        }
        CloseHandle(token);
    }
    if (pid != GetCurrentProcessId()) CloseHandle(process);
    return rid;
}

static std::string integrityName(DWORD rid) {
    if (rid == 0) return "unknown";
    if (rid < SECURITY_MANDATORY_MEDIUM_RID) return "low";
    if (rid < SECURITY_MANDATORY_HIGH_RID) return "medium";
    if (rid < SECURITY_MANDATORY_SYSTEM_RID) return "high";
    return "system";
}

static void ensureCanPostMessages(DWORD targetPid) {
    DWORD currentRid = integrityRidForProcess(GetCurrentProcessId());
    DWORD targetRid = integrityRidForProcess(targetPid);
    if (currentRid != 0 && targetRid != 0 && targetRid > currentRid) {
        throw std::runtime_error(
            "Windows blocked background input because the target app is running at a higher integrity level (" +
            integrityName(targetRid) + ") than Stella (" + integrityName(currentRid) + "). Run the target normally or use a matching-integrity Stella helper."
        );
    }
}

static void appendWindowProcess(std::vector<WindowProcess>& windows, const WindowProcess& item) {
    if (!item.hwnd || !IsWindow(item.hwnd) || item.pid == 0) return;
    for (WindowProcess& existing : windows) {
        if (existing.hwnd == item.hwnd) {
            if (existing.title.empty()) existing.title = item.title;
            if (existing.processName == L"unknown" && item.processName != L"unknown") existing.processName = item.processName;
            return;
        }
    }
    windows.push_back(item);
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
    appendWindowProcess(*out, item);
    return TRUE;
}

static void appendUiaWindowElement(IUIAutomationElement* element, std::vector<WindowProcess>& windows) {
    if (!element) return;
    UIA_HWND native = NULL;
    if (FAILED(element->get_CurrentNativeWindowHandle(&native)) || native == 0) return;
    HWND hwnd = (HWND)(intptr_t)native;
    if (!IsWindow(hwnd) || !IsWindowVisible(hwnd)) return;
    RECT rect = {};
    if (!GetWindowRect(hwnd, &rect) || rect.right <= rect.left || rect.bottom <= rect.top) return;
    int elementPid = 0;
    DWORD pid = 0;
    if (SUCCEEDED(element->get_CurrentProcessId(&elementPid)) && elementPid > 0) pid = (DWORD)elementPid;
    if (pid == 0) GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return;
    WindowProcess item;
    item.hwnd = hwnd;
    item.pid = pid;
    BSTR name = nullptr;
    if (SUCCEEDED(element->get_CurrentName(&name))) item.title = bstrToWstring(name);
    if (name) SysFreeString(name);
    if (item.title.empty()) item.title = getWindowText(hwnd);
    item.processName = processNameForPid(pid);
    appendWindowProcess(windows, item);
}

static void appendUiaWindows(IUIAutomation* uia, std::vector<WindowProcess>& windows) {
    if (!uia) return;
    IUIAutomationElement* root = nullptr;
    if (FAILED(uia->GetRootElement(&root)) || !root) return;
    VARIANT controlType;
    VariantInit(&controlType);
    controlType.vt = VT_I4;
    controlType.lVal = UIA_WindowControlTypeId;
    IUIAutomationCondition* condition = nullptr;
    IUIAutomationElementArray* elements = nullptr;
    if (SUCCEEDED(uia->CreatePropertyCondition(UIA_ControlTypePropertyId, controlType, &condition)) &&
        SUCCEEDED(root->FindAll(TreeScope_Children, condition, &elements)) && elements) {
        int length = 0;
        elements->get_Length(&length);
        for (int i = 0; i < length; i++) {
            IUIAutomationElement* element = nullptr;
            if (SUCCEEDED(elements->GetElement(i, &element)) && element) {
                appendUiaWindowElement(element, windows);
            }
            safeRelease(element);
        }
    }
    safeRelease(elements);
    safeRelease(condition);
    safeRelease(root);
}

static std::vector<WindowProcess> listWindowProcesses(IUIAutomation* uia = nullptr) {
    std::vector<WindowProcess> windows;
    EnumWindows(enumWindowsProc, reinterpret_cast<LPARAM>(&windows));
    appendUiaWindows(uia, windows);
    return windows;
}

static WindowProcess windowProcessFromHwnd(HWND hwnd) {
    if (!hwnd || !IsWindow(hwnd)) {
        throw std::runtime_error("windowNotFound");
    }
    RECT rect = {};
    if (!GetWindowRect(hwnd, &rect) || rect.right <= rect.left || rect.bottom <= rect.top) {
        throw std::runtime_error("windowNotFound");
    }
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) throw std::runtime_error("windowNotFound");
    WindowProcess item;
    item.hwnd = hwnd;
    item.pid = pid;
    item.title = getWindowText(hwnd);
    item.processName = processNameForPid(pid);
    return item;
}

static WindowProcess resolveApp(IUIAutomation* uia, const std::wstring& query, long long windowId = 0) {
    if (windowId > 0) return windowProcessFromHwnd(hwndFromValue(windowId));
    long long targetHwnd = parseHwndTarget(query);
    if (targetHwnd > 0) return windowProcessFromHwnd(hwndFromValue(targetHwnd));

    std::wstring normalized = query;
    std::wstring processQuery = normalized;
    if (processQuery.size() > 4 && lowerW(processQuery.substr(processQuery.size() - 4)) == L".exe") {
        processQuery.resize(processQuery.size() - 4);
    }
    std::wstring lowerQuery = lowerW(normalized);
    std::wstring lowerProcessQuery = lowerW(processQuery);
    DWORD pidQuery = (DWORD)_wtoi(normalized.c_str());

    std::vector<WindowProcess> windows = listWindowProcesses(uia);
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
        HWND previousForeground = GetForegroundWindow();
        SHELLEXECUTEINFOW info = {};
        info.cbSize = sizeof(info);
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpFile = normalized.c_str();
        info.nShow = SW_SHOWNOACTIVATE;
        if (ShellExecuteExW(&info) && info.hProcess) {
            DWORD launchedPid = GetProcessId(info.hProcess);
            for (int i = 0; i < 20; i++) {
                Sleep(250);
                for (const auto& win : listWindowProcesses(uia)) {
                    if (win.pid == launchedPid) {
                        HWND currentForeground = GetForegroundWindow();
                        if (previousForeground && currentForeground && previousForeground != currentForeground && IsWindow(previousForeground)) {
                            SetForegroundWindow(previousForeground);
                        }
                        CloseHandle(info.hProcess);
                        return win;
                    }
                }
            }
            CloseHandle(info.hProcess);
        }
        HWND currentForeground = GetForegroundWindow();
        if (previousForeground && currentForeground && previousForeground != currentForeground && IsWindow(previousForeground)) {
            SetForegroundWindow(previousForeground);
        }
    }

    throw std::runtime_error("appNotFound(\"" + toUtf8(query) + "\")");
}

static WindowProcess launchApp(IUIAutomation* uia, const std::wstring& query, bool startMinimized) {
    HWND previousForeground = GetForegroundWindow();
    std::set<long long> existingWindows;
    for (const auto& win : listWindowProcesses(uia)) {
        existingWindows.insert(hwndValue(win.hwnd));
    }
    SHELLEXECUTEINFOW info = {};
    info.cbSize = sizeof(info);
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpFile = query.c_str();
    info.nShow = startMinimized ? SW_SHOWMINNOACTIVE : SW_SHOWNOACTIVATE;
    DWORD launchedPid = 0;
    bool launchedOk = !!ShellExecuteExW(&info);
    if (launchedOk && info.hProcess) {
        launchedPid = GetProcessId(info.hProcess);
    }
    if (!launchedOk) {
        IApplicationActivationManager* activation = nullptr;
        HRESULT hr = CoCreateInstance(
            CLSID_ApplicationActivationManager,
            NULL,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&activation)
        );
        if (SUCCEEDED(hr) && activation) {
            hr = activation->ActivateApplication(query.c_str(), nullptr, AO_NONE, &launchedPid);
            activation->Release();
            launchedOk = SUCCEEDED(hr);
        }
    }
    if (!launchedOk) {
        throw std::runtime_error("launchFailed(\"" + toUtf8(query) + "\")");
    }

    WindowProcess launched;
    for (int i = 0; i < 40 && !launched.hwnd; i++) {
        Sleep(250);
        std::vector<WindowProcess> windows = listWindowProcesses(uia);
        for (const auto& win : windows) {
            if (launchedPid > 0 && win.pid == launchedPid) {
                launched = win;
                break;
            }
        }
        if (!launched.hwnd) {
            std::wstring lowerQuery = lowerW(query);
            for (const auto& win : windows) {
                std::wstring name = lowerW(win.processName);
                std::wstring title = lowerW(win.title);
                if (name == lowerQuery || name + L".exe" == lowerQuery ||
                    (!lowerQuery.empty() && title.find(lowerQuery) != std::wstring::npos)) {
                    launched = win;
                    break;
                }
            }
        }
        if (!launched.hwnd) {
            for (const auto& win : windows) {
                if (!existingWindows.count(hwndValue(win.hwnd))) {
                    launched = win;
                    break;
                }
            }
        }
    }
    if (info.hProcess) CloseHandle(info.hProcess);
    if (previousForeground && IsWindow(previousForeground) && GetForegroundWindow() != previousForeground) {
        SetForegroundWindow(previousForeground);
    }
    if (!launched.hwnd) {
        throw std::runtime_error("launchWindowNotFound(\"" + toUtf8(query) + "\")");
    }
    if (startMinimized) {
        ShowWindow(launched.hwnd, SW_SHOWMINNOACTIVE);
        ShowWindow(launched.hwnd, SW_MINIMIZE);
    }
    return launched;
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
    if (hwnd && SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect))) &&
        rect.right > rect.left && rect.bottom > rect.top) {
        return frameFromRect(rect);
    }
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

static const size_t MAX_TREE_ELEMENTS = 3000;
static const int MAX_TREE_DEPTH = 24;

static void appendTreeLine(const ElementRecord& record, int depth, std::vector<std::string>& lines) {
    std::wstring role = !record.localizedControlType.empty() ? record.localizedControlType : record.controlType;
    std::wstring title = elementTitle(record);
    std::string line((depth + 1), '\t');
    line += std::to_string(record.index) + " " + toUtf8(role) + " " + toUtf8(title);
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
}

static void renderTreeVisit(IUIAutomation* uia, IUIAutomationElement* node, int depth, const Frame& windowFrame,
                            std::set<std::string>& visited, std::vector<ElementRecord>& records,
                            std::vector<std::string>& lines) {
    if (!node || records.size() >= MAX_TREE_ELEMENTS || depth > MAX_TREE_DEPTH) return;
    std::vector<int> runtime = getRuntimeId(node);
    std::ostringstream key;
    for (int value : runtime) key << value << ".";
    std::string runtimeKey = key.str();
    if (runtimeKey.empty()) runtimeKey = std::to_string((uintptr_t)node);
    if (!visited.insert(runtimeKey).second) return;

    int index = (int)records.size();
    ElementRecord record = elementRecord(node, index, windowFrame);
    records.push_back(record);
    appendTreeLine(record, depth, lines);

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

static std::string encodeBitmapPngBase64(HBITMAP bitmap) {
    std::string out;
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
    return out;
}

static bool sampledBitmapLooksBlack(HDC dc, int width, int height) {
    int sampleCount = 0;
    int visibleCount = 0;
    int xStep = std::max(1, width / 20);
    int yStep = std::max(1, height / 20);
    for (int y = 0; y < height; y += yStep) {
        for (int x = 0; x < width; x += xStep) {
            COLORREF pixel = GetPixel(dc, x, y);
            if (pixel == CLR_INVALID) continue;
            sampleCount++;
            int brightness = (int)GetRValue(pixel) + (int)GetGValue(pixel) + (int)GetBValue(pixel);
            if (brightness > 36) visibleCount++;
        }
    }
    return sampleCount > 0 && visibleCount == 0;
}

static bool rectsOverlapEnough(const RECT& a, const RECT& b) {
    RECT intersection = {};
    if (!IntersectRect(&intersection, &a, &b)) return false;
    LONG width = intersection.right - intersection.left;
    LONG height = intersection.bottom - intersection.top;
    return width > 16 && height > 16;
}

static bool isWindowLikelyOccluded(HWND hwnd, const Frame& bounds) {
    if (!hwnd || !bounds.present) return false;
    RECT target = {
        (LONG)std::round(bounds.x),
        (LONG)std::round(bounds.y),
        (LONG)std::round(bounds.x + bounds.width),
        (LONG)std::round(bounds.y + bounds.height),
    };
    for (HWND candidate = GetTopWindow(NULL); candidate; candidate = GetWindow(candidate, GW_HWNDNEXT)) {
        if (candidate == hwnd) return false;
        if (!IsWindowVisible(candidate)) continue;
        RECT rect = {};
        if (!GetWindowRect(candidate, &rect) || rect.right <= rect.left || rect.bottom <= rect.top) continue;
        if (rectsOverlapEnough(target, rect)) return true;
    }
    return false;
}

static std::string captureScreenRegionPngBase64(const Frame& bounds) {
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
        out = encodeBitmapPngBase64(bitmap);
    }

    SelectObject(mem, old);
    DeleteObject(bitmap);
    DeleteDC(mem);
    ReleaseDC(NULL, screen);
    return out;
}

static std::string capturePrintWindowPngBase64(HWND hwnd, const Frame& bounds) {
    if (!hwnd || !bounds.present || bounds.width <= 0 || bounds.height <= 0) return "";
    int width = std::max(1, (int)std::round(bounds.width));
    int height = std::max(1, (int)std::round(bounds.height));
    HDC screen = GetDC(NULL);
    HDC mem = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, width, height);
    HGDIOBJ old = SelectObject(mem, bitmap);
    RECT fill = {0, 0, width, height};
    FillRect(mem, &fill, (HBRUSH)GetStockObject(BLACK_BRUSH));
    BOOL ok = PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT);
    if (!ok) ok = PrintWindow(hwnd, mem, 0);

    std::string out;
    if (ok && !sampledBitmapLooksBlack(mem, width, height)) {
        out = encodeBitmapPngBase64(bitmap);
    }

    SelectObject(mem, old);
    DeleteObject(bitmap);
    DeleteDC(mem);
    ReleaseDC(NULL, screen);
    return out;
}

static std::string captureWindowPngBase64(HWND hwnd, const Frame& bounds, std::string* methodOut = nullptr) {
    std::string out = capturePrintWindowPngBase64(hwnd, bounds);
    if (!out.empty()) {
        if (methodOut) *methodOut = "printwindow";
        return out;
    }
    if (methodOut) *methodOut = "bitblt";
    return captureScreenRegionPngBase64(bounds);
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

static Snapshot buildSnapshot(IUIAutomation* uia, const std::wstring& query, long long windowId = 0) {
    WindowProcess process = resolveApp(uia, query, windowId);
    IUIAutomationElement* root = nullptr;
    HRESULT hr = uia->ElementFromHandle(process.hwnd, &root);
    if (FAILED(hr) || !root) {
        throw std::runtime_error("No top-level UI Automation window is available for " + toUtf8(process.processName));
    }
    Snapshot snapshot;
    snapshot.appName = process.processName;
    snapshot.pid = process.pid;
    snapshot.windowId = hwndValue(process.hwnd);
    snapshot.windowTitle = process.title;
    snapshot.windowBounds = windowBounds(process.hwnd, root);
    std::set<std::string> visited;
    renderTreeVisit(uia, root, 0, snapshot.windowBounds, visited, snapshot.elements, snapshot.treeLines);
    snapshot.screenshotBase64 = captureWindowPngBase64(process.hwnd, snapshot.windowBounds, &snapshot.captureMethod);
    snapshot.captureOccluded = snapshot.captureMethod == "bitblt" && isWindowLikelyOccluded(process.hwnd, snapshot.windowBounds);
    if (snapshot.captureOccluded) {
        snapshot.warnings.push_back("Screenshot used screen-region capture while another window appears to overlap the target; pixels may include the covering window.");
    }
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

struct InputState {
    HWND foreground = NULL;
    POINT cursor = {};
    bool cursorKnown = false;
};

static InputState captureInputState() {
    InputState state;
    state.foreground = GetForegroundWindow();
    state.cursorKnown = !!GetCursorPos(&state.cursor);
    return state;
}

static void restoreInputState(const InputState& state) {
    if (state.cursorKnown) SetCursorPos(state.cursor.x, state.cursor.y);
    if (state.foreground && IsWindow(state.foreground) && GetForegroundWindow() != state.foreground) {
        SetForegroundWindow(state.foreground);
    }
}

static void ensureForegroundInputTarget(HWND hwnd) {
    if (!hwnd || !IsWindow(hwnd)) throw std::runtime_error("foreground dispatch target window is unavailable");
    if (GetForegroundWindow() == hwnd) return;
    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    SetForegroundWindow(hwnd);
    Sleep(80);
    if (GetForegroundWindow() != hwnd) {
        throw std::runtime_error("foreground dispatch was blocked by Windows foreground activation policy");
    }
}

static bool isKnownBackgroundDropTarget(const WindowProcess& process, const std::string& eventKind) {
    std::wstring haystack = lowerW(process.processName + L" " + classNameForWindow(process.hwnd));
    bool chromium = haystack.find(L"chrome_widgetwin") != std::wstring::npos ||
                    haystack.find(L"chrome") != std::wstring::npos ||
                    haystack.find(L"msedge") != std::wstring::npos ||
                    haystack.find(L"electron") != std::wstring::npos;
    bool xaml = haystack.find(L"applicationframewindow") != std::wstring::npos ||
                haystack.find(L"windows.ui.core") != std::wstring::npos ||
                haystack.find(L"xaml") != std::wstring::npos;
    bool gtk = haystack.find(L"gtk") != std::wstring::npos || haystack.find(L"gdk") != std::wstring::npos;
    bool vcl = haystack.find(L"tapplication") != std::wstring::npos || haystack.find(L"vcl") != std::wstring::npos;
    if (eventKind == "mouse" || eventKind == "drag" || eventKind == "scroll") {
        return chromium || xaml || gtk || vcl;
    }
    if (eventKind == "keyboard" || eventKind == "text") {
        return xaml || gtk || vcl;
    }
    return false;
}

static bool shouldUseForegroundDispatch(const WindowProcess& process, const std::string& eventKind, const std::string& dispatch) {
    if (dispatch == "foreground") return true;
    bool knownDrop = isKnownBackgroundDropTarget(process, eventKind);
    if (dispatch == "auto") return knownDrop;
    if (dispatch == "background" && knownDrop) {
        throw std::runtime_error(
            "background_unavailable: Windows is likely to silently drop " + eventKind +
            " input for this target framework; retry with --dispatch foreground or --dispatch auto."
        );
    }
    return false;
}

static void sendForegroundClick(HWND hwnd, POINT screen, const std::string& button, int count) {
    InputState state = captureInputState();
    ensureForegroundInputTarget(hwnd);
    SetCursorPos(screen.x, screen.y);
    DWORD down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
    if (button == "right") {
        down = MOUSEEVENTF_RIGHTDOWN;
        up = MOUSEEVENTF_RIGHTUP;
    } else if (button == "middle") {
        down = MOUSEEVENTF_MIDDLEDOWN;
        up = MOUSEEVENTF_MIDDLEUP;
    }
    for (int i = 0; i < std::max(1, count); i++) {
        mouse_event(down, 0, 0, 0, 0);
        Sleep(35);
        mouse_event(up, 0, 0, 0, 0);
        Sleep(50);
    }
    restoreInputState(state);
}

static void sendForegroundDrag(HWND hwnd, POINT from, POINT to) {
    InputState state = captureInputState();
    ensureForegroundInputTarget(hwnd);
    SetCursorPos(from.x, from.y);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    for (int i = 1; i <= 16; i++) {
        int x = (int)std::round(from.x + (to.x - from.x) * i / 16.0);
        int y = (int)std::round(from.y + (to.y - from.y) * i / 16.0);
        SetCursorPos(x, y);
        Sleep(20);
    }
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    restoreInputState(state);
}

static void sendForegroundScroll(HWND hwnd, POINT screen, const std::string& direction, double pages) {
    InputState state = captureInputState();
    ensureForegroundInputTarget(hwnd);
    SetCursorPos(screen.x, screen.y);
    int delta = (int)std::round(120 * pages);
    DWORD flag = MOUSEEVENTF_WHEEL;
    if (direction == "down" || direction == "right") delta *= -1;
    if (direction == "left" || direction == "right") flag = MOUSEEVENTF_HWHEEL;
    mouse_event(flag, 0, 0, (DWORD)delta, 0);
    restoreInputState(state);
}

static std::vector<std::string> keyParts(const std::string& key) {
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
    return parts;
}

static void sendForegroundKey(HWND hwnd, const std::string& key) {
    InputState state = captureInputState();
    ensureForegroundInputTarget(hwnd);
    std::vector<std::string> parts = keyParts(key);
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
    auto sendVk = [](WORD vk, DWORD flags) {
        INPUT input = {};
        input.type = INPUT_KEYBOARD;
        input.ki.wVk = vk;
        input.ki.dwFlags = flags;
        SendInput(1, &input, sizeof(INPUT));
    };
    for (int mod : modifiers) sendVk((WORD)mod, 0);
    WORD vk = (WORD)virtualKey(parts.back());
    sendVk(vk, 0);
    Sleep(25);
    sendVk(vk, KEYEVENTF_KEYUP);
    std::reverse(modifiers.begin(), modifiers.end());
    for (int mod : modifiers) sendVk((WORD)mod, KEYEVENTF_KEYUP);
    restoreInputState(state);
}

static void sendForegroundText(HWND hwnd, const std::wstring& text) {
    InputState state = captureInputState();
    ensureForegroundInputTarget(hwnd);
    for (wchar_t ch : text) {
        INPUT inputs[2] = {};
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].ki.wScan = ch;
        inputs[0].ki.dwFlags = KEYEVENTF_UNICODE;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].ki.wScan = ch;
        inputs[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        SendInput(2, inputs, sizeof(INPUT));
        Sleep(8);
    }
    restoreInputState(state);
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
    IUIAutomationExpandCollapsePattern* expand = getPattern<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId);
    if (expand) {
        ExpandCollapseState state = ExpandCollapseState_LeafNode;
        HRESULT hr = expand->get_CurrentExpandCollapseState(&state);
        bool attempted = false;
        if (SUCCEEDED(hr) && state == ExpandCollapseState_Collapsed) {
            hr = expand->Expand();
            attempted = true;
        } else if (SUCCEEDED(hr) && state == ExpandCollapseState_Expanded) {
            hr = expand->Collapse();
            attempted = true;
        }
        expand->Release();
        if (attempted && SUCCEEDED(hr)) return true;
    }
    return false;
}

static bool hasPreferredClickPattern(IUIAutomationElement* element) {
    IUIAutomationInvokePattern* invoke = getPattern<IUIAutomationInvokePattern>(element, UIA_InvokePatternId);
    if (invoke) {
        invoke->Release();
        return true;
    }
    IUIAutomationSelectionItemPattern* select = getPattern<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId);
    if (select) {
        select->Release();
        return true;
    }
    IUIAutomationTogglePattern* toggle = getPattern<IUIAutomationTogglePattern>(element, UIA_TogglePatternId);
    if (toggle) {
        toggle->Release();
        return true;
    }
    IUIAutomationExpandCollapsePattern* expand = getPattern<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId);
    if (expand) {
        expand->Release();
        return true;
    }
    return false;
}

static bool elementContainsScreenPoint(IUIAutomationElement* element, DWORD pid, POINT screen, const Frame& windowFrame, double* areaOut) {
    if (!element) return false;
    int elementPid = 0;
    if (FAILED(element->get_CurrentProcessId(&elementPid)) || (DWORD)elementPid != pid) return false;
    RECT rect = {};
    if (FAILED(element->get_CurrentBoundingRectangle(&rect))) return false;
    if (rect.right <= rect.left || rect.bottom <= rect.top) return false;
    if (screen.x < rect.left || screen.x > rect.right || screen.y < rect.top || screen.y > rect.bottom) return false;
    if (windowFrame.present) {
        double windowRight = windowFrame.x + windowFrame.width;
        double windowBottom = windowFrame.y + windowFrame.height;
        if (rect.right < windowFrame.x || rect.left > windowRight || rect.bottom < windowFrame.y || rect.top > windowBottom) return false;
    }
    if (areaOut) *areaOut = (double)(rect.right - rect.left) * (double)(rect.bottom - rect.top);
    return true;
}

static bool invokeClickableElementAtPoint(IUIAutomation* uia, IUIAutomationElement* root, DWORD pid, POINT screen, const Frame& windowFrame) {
    std::vector<IUIAutomationElement*> all;
    collectAllElements(uia, root, all);
    IUIAutomationElement* best = nullptr;
    double bestArea = 1.0e300;
    for (IUIAutomationElement* candidate : all) {
        double area = 0;
        if (!elementContainsScreenPoint(candidate, pid, screen, windowFrame, &area)) continue;
        if (!hasPreferredClickPattern(candidate)) continue;
        if (area < bestArea) {
            best = candidate;
            bestArea = area;
        }
    }
    bool handled = best && invokePreferredClick(best);
    for (IUIAutomationElement* candidate : all) candidate->Release();
    return handled;
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

static std::string receiptJson(const ActionProbe& before, const std::string& route, const std::string& dispatch, int settleMs) {
    POINT after = {};
    bool afterKnown = !!GetCursorPos(&after);
    bool cursorMoved = !before.cursorKnown || !afterKnown || before.cursor.x != after.x || before.cursor.y != after.y;
    bool foregroundChanged = before.foreground != (long long)GetForegroundWindow();
    std::ostringstream out;
    out << "{\"ok\":true,\"route\":" << jsonString(route)
        << ",\"dispatch\":" << jsonString(dispatch)
        << ",\"lane\":\"same_session\",\"background_safe\":" << ((!cursorMoved && !foregroundChanged) ? "true" : "false")
        << ",\"cursor_moved\":" << (cursorMoved ? "true" : "false")
        << ",\"foreground_changed\":" << (foregroundChanged ? "true" : "false")
        << ",\"session\":\"parent\""
        << ",\"settle\":{\"observed\":false,\"quietMs\":0,\"waitedMs\":" << settleMs
        << ",\"eventCount\":0,\"timedOut\":false,\"reason\":\"fixed-post-action-delay\"}}";
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
        << ",\"pid\":" << snapshot.pid << "},\"windowId\":" << snapshot.windowId
        << ",\"windowTitle\":" << jsonString(toUtf8(snapshot.windowTitle))
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
    out << ",\"warnings\":[";
    for (size_t i = 0; i < snapshot.warnings.size(); i++) {
        if (i) out << ",";
        out << jsonString(snapshot.warnings[i]);
    }
    out << "],\"capture\":{\"method\":";
    if (snapshot.captureMethod.empty()) out << "null";
    else out << jsonString(snapshot.captureMethod);
    out << ",\"occluded\":" << (snapshot.captureOccluded ? "true" : "false");
    if (snapshot.captureOccluded && !snapshot.warnings.empty()) {
        out << ",\"warning\":" << jsonString(snapshot.warnings.front());
    }
    out << "}";
    out << ",\"elements\":[";
    for (size_t i = 0; i < snapshot.elements.size(); i++) {
        if (i) out << ",";
        out << elementJson(snapshot.elements[i]);
    }
    out << "]}";
    return out.str();
}

static std::string listAppsText(IUIAutomation* uia) {
    std::vector<WindowProcess> windows = listWindowProcesses(uia);
    std::sort(windows.begin(), windows.end(), [](const WindowProcess& a, const WindowProcess& b) {
        if (lowerW(a.processName) == lowerW(b.processName)) return a.pid < b.pid;
        return lowerW(a.processName) < lowerW(b.processName);
    });
    std::ostringstream out;
    for (size_t i = 0; i < windows.size(); i++) {
        if (i) out << "\n";
        std::string title = toUtf8(windows[i].title.empty() ? L"untitled" : windows[i].title);
        std::string name = toUtf8(windows[i].processName);
        out << name << " -- " << name << " [running, pid=" << windows[i].pid
            << ", target=hwnd:" << hwndValue(windows[i].hwnd) << ", window=" << title << "]";
    }
    return out.str();
}

static std::wstring classNameForWindow(HWND hwnd) {
    wchar_t buffer[256] = {};
    int length = GetClassNameW(hwnd, buffer, (int)(sizeof(buffer) / sizeof(buffer[0])));
    return length > 0 ? std::wstring(buffer, buffer + length) : L"";
}

static std::string windowRecordJson(const WindowProcess& window) {
    RECT rect = {};
    Frame bounds;
    if (GetWindowRect(window.hwnd, &rect)) bounds = frameFromRect(rect);
    std::ostringstream out;
    out << "{\"pid\":" << window.pid
        << ",\"windowId\":" << hwndValue(window.hwnd)
        << ",\"app\":" << jsonString(toUtf8(window.processName))
        << ",\"title\":" << jsonString(toUtf8(window.title))
        << ",\"bounds\":" << frameJson(bounds)
        << ",\"foreground\":" << (GetForegroundWindow() == window.hwnd ? "true" : "false")
        << ",\"className\":" << jsonString(toUtf8(classNameForWindow(window.hwnd)))
        << "}";
    return out.str();
}

static std::string listWindowsText(IUIAutomation* uia) {
    std::vector<WindowProcess> windows = listWindowProcesses(uia);
    std::sort(windows.begin(), windows.end(), [](const WindowProcess& a, const WindowProcess& b) {
        if (lowerW(a.processName) == lowerW(b.processName)) return hwndValue(a.hwnd) < hwndValue(b.hwnd);
        return lowerW(a.processName) < lowerW(b.processName);
    });
    std::ostringstream out;
    for (size_t i = 0; i < windows.size(); i++) {
        if (i) out << "\n";
        RECT rect = {};
        Frame bounds;
        if (GetWindowRect(windows[i].hwnd, &rect)) bounds = frameFromRect(rect);
        std::string title = toUtf8(windows[i].title.empty() ? L"untitled" : windows[i].title);
        std::string name = toUtf8(windows[i].processName);
        out << name << " -- " << title << " [pid=" << windows[i].pid
            << ", window-id=" << hwndValue(windows[i].hwnd)
            << ", target=hwnd:" << hwndValue(windows[i].hwnd);
        if (bounds.present) {
            out << ", bounds=" << (int)std::round(bounds.x) << "," << (int)std::round(bounds.y)
                << " " << (int)std::round(bounds.width) << "x" << (int)std::round(bounds.height);
        }
        out << ", class=" << toUtf8(classNameForWindow(windows[i].hwnd)) << "]";
    }
    return out.str();
}

static std::string listWindowsJson(IUIAutomation* uia) {
    std::vector<WindowProcess> windows = listWindowProcesses(uia);
    std::sort(windows.begin(), windows.end(), [](const WindowProcess& a, const WindowProcess& b) {
        if (lowerW(a.processName) == lowerW(b.processName)) return hwndValue(a.hwnd) < hwndValue(b.hwnd);
        return lowerW(a.processName) < lowerW(b.processName);
    });
    std::ostringstream out;
    out << "{\"ok\":true,\"text\":" << jsonString(listWindowsText(uia)) << ",\"windows\":[";
    for (size_t i = 0; i < windows.size(); i++) {
        if (i) out << ",";
        out << windowRecordJson(windows[i]);
    }
    out << "]}";
    return out.str();
}

static std::string doctorText(IUIAutomation* uia) {
    DWORD sessionId = 0;
    bool hasSession = !!ProcessIdToSessionId(GetCurrentProcessId(), &sessionId);
    HDESK inputDesktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    bool hasInputDesktop = inputDesktop != NULL;
    if (inputDesktop) CloseDesktop(inputDesktop);
    std::vector<WindowProcess> windows = listWindowProcesses(uia);
    DWORD foregroundPid = 0;
    HWND foreground = GetForegroundWindow();
    if (foreground) GetWindowThreadProcessId(foreground, &foregroundPid);

    std::ostringstream out;
    out << "Windows runtime: stella-computer-helper.exe\n";
    out << "UI Automation: available\n";
    out << "Process session: " << (hasSession ? std::to_string(sessionId) : "unknown");
    if (hasSession && sessionId == 0) out << " (not an interactive user desktop)";
    out << "\n";
    out << "Interactive desktop: " << (hasInputDesktop ? "available" : "not available") << "\n";
    out << "Process integrity: " << integrityName(integrityRidForProcess(GetCurrentProcessId())) << "\n";
    out << "Visible top-level windows: " << windows.size() << "\n";
    if (foreground) {
        out << "Foreground window: target=hwnd:" << hwndValue(foreground) << " pid=" << foregroundPid << "\n";
    }
    out << "Background input: Win32 messages can be blocked by higher-integrity target apps; Stella reports that instead of pretending the click worked.";
    return out.str();
}

static long long operationWindowId(const Json& operation) {
    const Json* value = operation.get("windowId");
    return value && value->type == Json::Number ? (long long)value->numberValue : 0;
}

static std::string failJson(const std::string& error) {
    return "{\"ok\":false,\"error\":" + jsonString(error) + "}";
}

static std::string okSnapshotJson(const Snapshot& snapshot) {
    return "{\"ok\":true,\"snapshot\":" + snapshotJson(snapshot) + "}";
}

static std::string executeOperation(IUIAutomation* uia, const Json& operation);

struct DaemonOptions {
    std::wstring pipeName;
    std::wstring pidFile;
};

static bool writeUtf8File(const std::wstring& path, const std::string& text) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    BOOL ok = WriteFile(file, text.data(), (DWORD)text.size(), &written, NULL);
    CloseHandle(file);
    return ok && written == text.size();
}

static DaemonOptions parseDaemonOptions(int argc, char** argv) {
    DaemonOptions options;
    for (int i = 2; i + 1 < argc; i++) {
        std::string key = argv[i] ? argv[i] : "";
        std::wstring value = toWide(argv[i + 1] ? argv[i + 1] : "");
        if (key == "--pipe-name") {
            options.pipeName = value;
            i++;
        } else if (key == "--pid-file") {
            options.pidFile = value;
            i++;
        }
    }
    if (options.pipeName.empty() || options.pidFile.empty()) {
        throw std::runtime_error("stella-computer-helper daemon requires --pipe-name and --pid-file.");
    }
    return options;
}

static std::string daemonEnvelope(long long seq, int status, const std::string& stdoutText, const std::string& stderrText) {
    std::ostringstream out;
    out << "{\"seq\":" << seq
        << ",\"status\":" << status
        << ",\"stdout\":" << jsonString(stdoutText)
        << ",\"stderr\":" << jsonString(stderrText)
        << "}";
    return out.str();
}

static std::string readPipeRequest(HANDLE pipe) {
    std::string request;
    char buffer[4096];
    while (true) {
        DWORD read = 0;
        BOOL ok = ReadFile(pipe, buffer, sizeof(buffer), &read, NULL);
        if (!ok || read == 0) break;
        request.append(buffer, buffer + read);
        if (request.find('\n') != std::string::npos) break;
    }
    size_t newline = request.find('\n');
    if (newline != std::string::npos) request.resize(newline);
    return request;
}

static void writePipeResponse(HANDLE pipe, const std::string& response) {
    std::string text = response + "\n";
    DWORD written = 0;
    WriteFile(pipe, text.data(), (DWORD)text.size(), &written, NULL);
    FlushFileBuffers(pipe);
}

static std::string executeDaemonPayload(IUIAutomation* uia, const std::string& payload) {
    if (payload.empty()) return "";
    try {
        JsonParser parser(payload);
        Json request = parser.parseValue();
        long long seq = (long long)request.num("seq", 0);
        const Json* operation = request.get("operation");
        if (!operation || operation->type != Json::Object) {
            return daemonEnvelope(seq, 1, "", "invalid daemon request");
        }
        try {
            return daemonEnvelope(seq, 0, executeOperation(uia, *operation), "");
        } catch (const std::exception& error) {
            return daemonEnvelope(seq, 0, failJson(error.what()), "");
        }
    } catch (const std::exception& error) {
        return daemonEnvelope(0, 1, "", error.what());
    }
}

static int runDaemon(IUIAutomation* uia, const DaemonOptions& options) {
    writeUtf8File(options.pidFile, std::to_string(GetCurrentProcessId()));
    while (true) {
        HANDLE pipe = CreateNamedPipeW(
            options.pipeName.c_str(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            1024 * 1024,
            1024 * 1024,
            0,
            NULL
        );
        if (pipe == INVALID_HANDLE_VALUE) {
            Sleep(200);
            continue;
        }
        BOOL connected = ConnectNamedPipe(pipe, NULL) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
        if (connected) {
            std::string request = readPipeRequest(pipe);
            std::string response = executeDaemonPayload(uia, request);
            if (!response.empty()) writePipeResponse(pipe, response);
        }
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }
}

static int operationElementIndex(const Json& operation) {
    const Json* element = operation.get("element");
    return element ? (int)element->num("index", -1) : -1;
}

static std::string executeOperation(IUIAutomation* uia, const Json& operation) {
    std::string tool = operation.str("tool");
    if (tool == "list_apps") {
        return "{\"ok\":true,\"text\":" + jsonString(listAppsText(uia)) + "}";
    }
    if (tool == "list_windows") {
        return listWindowsJson(uia);
    }
    if (tool == "doctor") {
        return "{\"ok\":true,\"text\":" + jsonString(doctorText(uia)) + "}";
    }
    std::wstring app = toWide(operation.str("app"));
    long long windowId = operationWindowId(operation);
    if (tool == "get_app_state") {
        return okSnapshotJson(buildSnapshot(uia, app, windowId));
    }
    if (tool == "launch_app") {
        const Json* startMinimizedValue = operation.get("start_minimized");
        bool startMinimized = startMinimizedValue && startMinimizedValue->type == Json::Bool && startMinimizedValue->boolValue;
        WindowProcess launched = launchApp(uia, app, startMinimized);
        Snapshot snapshot = buildSnapshot(uia, app, hwndValue(launched.hwnd));
        std::ostringstream out;
        out << "{\"ok\":true,\"text\":"
            << jsonString("Launched " + toUtf8(launched.processName) + " target=hwnd:" + std::to_string(hwndValue(launched.hwnd)))
            << ",\"windows\":[" << windowRecordJson(launched) << "]"
            << ",\"snapshot\":" << snapshotJson(snapshot) << "}";
        return out.str();
    }

    WindowProcess process = resolveApp(uia, app, windowId);
    IUIAutomationElement* root = nullptr;
    if (FAILED(uia->ElementFromHandle(process.hwnd, &root)) || !root) {
        throw std::runtime_error("No top-level UI Automation window is available for " + toUtf8(process.processName));
    }
    IUIAutomationElement* element = nullptr;
    try {
    const Json* elementJsonValue = operation.get("element");
    element = findElement(uia, root, elementJsonValue);
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
    std::string dispatch = operation.str("dispatch", "background");
    if (dispatch != "background" && dispatch != "foreground" && dispatch != "auto") {
        throw std::runtime_error("unsupported dispatch mode: " + dispatch);
    }

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
            int clickCount = (int)operation.num("click_count", 1);
            if (button == "left" && clickCount == 1) {
                handled = invokeClickableElementAtPoint(uia, root, process.pid, point, windowFrame);
                if (handled) route = "uia.hit_test.click";
            }
            if (!handled) {
                if (shouldUseForegroundDispatch(process, "mouse", dispatch)) {
                    sendForegroundClick(process.hwnd, point, button, clickCount);
                    route = "foreground.sendinput.click";
                } else {
                    ensureCanPostMessages(process.pid);
                    sendMouseClick(process.hwnd, point, button, clickCount);
                    route = "hwnd.postmessage.click";
                }
            }
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
            if (shouldUseForegroundDispatch(process, "scroll", dispatch)) {
                sendForegroundScroll(process.hwnd, point, direction, pages);
                route = "foreground.sendinput.scroll";
            } else {
                ensureCanPostMessages(process.pid);
                sendScroll(process.hwnd, point, direction, pages);
                route = "hwnd.postmessage.scroll";
            }
        }
    } else if (tool == "drag") {
        POINT from = {(LONG)std::round(windowFrame.x + operation.num("from_x")), (LONG)std::round(windowFrame.y + operation.num("from_y"))};
        POINT to = {(LONG)std::round(windowFrame.x + operation.num("to_x")), (LONG)std::round(windowFrame.y + operation.num("to_y"))};
        if (shouldUseForegroundDispatch(process, "drag", dispatch)) {
            sendForegroundDrag(process.hwnd, from, to);
            route = "foreground.sendinput.drag";
        } else {
            ensureCanPostMessages(process.pid);
            sendDrag(process.hwnd, from, to);
            route = "hwnd.postmessage.drag";
        }
    } else if (tool == "type_text") {
        std::wstring text = toWide(operation.str("text"));
        if (invokeTypeText(uia, root, process, text)) route = "uia_or_hwnd.text_target";
        else {
            if (shouldUseForegroundDispatch(process, "text", dispatch)) {
                sendForegroundText(process.hwnd, text);
                route = "foreground.sendinput.text";
            } else {
                ensureCanPostMessages(process.pid);
                sendText(process.hwnd, text);
                route = "hwnd.postmessage.text";
            }
        }
    } else if (tool == "press_key") {
        if (shouldUseForegroundDispatch(process, "keyboard", dispatch)) {
            sendForegroundKey(process.hwnd, operation.str("key"));
            route = "foreground.sendinput.key";
        } else {
            ensureCanPostMessages(process.pid);
            sendKey(process.hwnd, operation.str("key"));
            route = "hwnd.postmessage.key";
        }
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

    Sleep(postActionSettleMs);
    Snapshot refreshed = buildSnapshot(uia, app, hwndValue(process.hwnd));
    std::string response = "{\"ok\":true,\"receipt\":" + receiptJson(probe, route, dispatch, postActionSettleMs) + ",\"snapshot\":" + snapshotJson(refreshed) + "}";
    safeRelease(element);
    safeRelease(root);
    return response;
    } catch (...) {
        safeRelease(element);
        safeRelease(root);
        throw;
    }
}

int main(int argc, char** argv) {
    SetConsoleOutputCP(CP_UTF8);
    bool daemonMode = argc >= 2 && std::string(argv[1] ? argv[1] : "") == "daemon";
    if (!daemonMode && argc != 2) {
        printf("%s\n", failJson("Usage: stella-computer-helper.exe <operation.json> | daemon --pipe-name PIPE --pid-file PATH").c_str());
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

    if (daemonMode) {
        try {
            int code = runDaemon(uia, parseDaemonOptions(argc, argv));
            safeRelease(uia);
            if (gdiplusToken) Gdiplus::GdiplusShutdown(gdiplusToken);
            return code;
        } catch (const std::exception& error) {
            safeRelease(uia);
            if (gdiplusToken) Gdiplus::GdiplusShutdown(gdiplusToken);
            printf("%s\n", failJson(error.what()).c_str());
            return 0;
        }
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
