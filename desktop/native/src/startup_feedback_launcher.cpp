#include <windows.h>
#include <shellapi.h>

#include <cstdio>
#include <string>
#include <vector>

static std::wstring quoteArg(const std::wstring& arg) {
    if (arg.empty()) {
        return L"\"\"";
    }

    bool needsQuoting = false;
    for (wchar_t ch : arg) {
        if (ch == L' ' || ch == L'\t' || ch == L'\n' || ch == L'\v' || ch == L'"') {
            needsQuoting = true;
            break;
        }
    }
    if (!needsQuoting) {
        return arg;
    }

    std::wstring result;
    result.push_back(L'"');
    size_t backslashes = 0;
    for (wchar_t ch : arg) {
        if (ch == L'\\') {
            backslashes += 1;
            continue;
        }

        if (ch == L'"') {
            result.append(backslashes * 2 + 1, L'\\');
            result.push_back(ch);
            backslashes = 0;
            continue;
        }

        result.append(backslashes, L'\\');
        backslashes = 0;
        result.push_back(ch);
    }
    result.append(backslashes * 2, L'\\');
    result.push_back(L'"');
    return result;
}

int main() {
    int argc = 0;
    wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) {
        fwprintf(
            stderr,
            L"startup_feedback_launcher: failed to parse command line (%lu)\n",
            GetLastError()
        );
        return 1;
    }

    if (argc < 2) {
        fwprintf(stderr, L"usage: startup_feedback_launcher.exe <binary> [args...]\n");
        LocalFree(argv);
        return 1;
    }

    std::wstring commandLine;
    for (int i = 1; i < argc; i += 1) {
        if (!commandLine.empty()) {
            commandLine.push_back(L' ');
        }
        commandLine += quoteArg(argv[i]);
    }
    std::vector<wchar_t> mutableCommandLine(commandLine.begin(), commandLine.end());
    mutableCommandLine.push_back(L'\0');

    STARTUPINFOW startupInfo;
    ZeroMemory(&startupInfo, sizeof(startupInfo));
    startupInfo.cb = sizeof(startupInfo);
    startupInfo.dwFlags = STARTF_FORCEOFFFEEDBACK;

    HANDLE stdIn = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE stdOut = GetStdHandle(STD_OUTPUT_HANDLE);
    HANDLE stdErr = GetStdHandle(STD_ERROR_HANDLE);
    if (
        stdIn != NULL && stdIn != INVALID_HANDLE_VALUE &&
        stdOut != NULL && stdOut != INVALID_HANDLE_VALUE &&
        stdErr != NULL && stdErr != INVALID_HANDLE_VALUE
    ) {
        startupInfo.dwFlags |= STARTF_USESTDHANDLES;
        startupInfo.hStdInput = stdIn;
        startupInfo.hStdOutput = stdOut;
        startupInfo.hStdError = stdErr;
    }

    PROCESS_INFORMATION processInfo;
    ZeroMemory(&processInfo, sizeof(processInfo));

    BOOL ok = CreateProcessW(
        argv[1],
        mutableCommandLine.data(),
        NULL,
        NULL,
        TRUE,
        0,
        NULL,
        NULL,
        &startupInfo,
        &processInfo
    );
    if (!ok) {
        fwprintf(
            stderr,
            L"startup_feedback_launcher: CreateProcessW failed for %ls (%lu)\n",
            argv[1],
            GetLastError()
        );
        LocalFree(argv);
        return 1;
    }

    LocalFree(argv);

    WaitForSingleObject(processInfo.hProcess, INFINITE);

    DWORD exitCode = 1;
    if (!GetExitCodeProcess(processInfo.hProcess, &exitCode)) {
        exitCode = 1;
    }

    CloseHandle(processInfo.hThread);
    CloseHandle(processInfo.hProcess);

    if (exitCode == STILL_ACTIVE) {
        return 1;
    }
    return static_cast<int>(exitCode);
}
