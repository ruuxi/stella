// mouse_block.exe - Standalone helper that blocks Ctrl+Right-click
// Compile: cl /O2 /EHsc mouse_block.cpp /link user32.lib /OUT:mouse_block.exe
// Or with MinGW: g++ -O2 -static mouse_block.cpp -o mouse_block.exe -luser32

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>

static HHOOK g_hook = nullptr;
static volatile bool g_running = true;
static volatile bool g_blockingActive = false; // Track active blocking session

static LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam)
{
    if (nCode == HC_ACTION)
    {
        MSLLHOOKSTRUCT* data = (MSLLHOOKSTRUCT*)lParam;
        
        if (wParam == WM_RBUTTONDOWN)
        {
            // Only start blocking if Ctrl is held at the time of mousedown
            bool ctrlHeld = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
            
            if (ctrlHeld)
            {
                g_blockingActive = true; // Start blocking session
                printf("DOWN %ld %ld\n", data->pt.x, data->pt.y);
                fflush(stdout);
                return 1; // Block the event
            }
        }
        else if (wParam == WM_RBUTTONUP)
        {
            // If we're in a blocking session, block the up event too
            // This handles the case where user releases Ctrl before releasing right-click
            if (g_blockingActive)
            {
                g_blockingActive = false; // End blocking session
                printf("UP %ld %ld\n", data->pt.x, data->pt.y);
                fflush(stdout);
                return 1; // Block the event
            }
        }
    }
    
    return CallNextHookEx(g_hook, nCode, wParam, lParam);
}

static BOOL WINAPI CtrlHandler(DWORD ctrlType)
{
    if (ctrlType == CTRL_C_EVENT || ctrlType == CTRL_CLOSE_EVENT ||
        ctrlType == CTRL_BREAK_EVENT || ctrlType == CTRL_SHUTDOWN_EVENT)
    {
        g_running = false;
        PostQuitMessage(0);
        return TRUE;
    }
    return FALSE;
}

int main()
{
    // Disable stdout buffering for immediate output
    setvbuf(stdout, nullptr, _IONBF, 0);
    
    SetConsoleCtrlHandler(CtrlHandler, TRUE);
    
    // Use NULL for hMod since we're an exe, not a DLL
    g_hook = SetWindowsHookExW(WH_MOUSE_LL, LowLevelMouseProc, NULL, 0);
    if (!g_hook)
    {
        fprintf(stderr, "Failed to install hook: %lu\n", GetLastError());
        return 1;
    }
    
    // Signal ready
    printf("READY\n");
    fflush(stdout);
    
    // Message loop - required for low-level hooks
    MSG msg;
    while (g_running && GetMessageW(&msg, nullptr, 0, 0) > 0)
    {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    
    UnhookWindowsHookEx(g_hook);
    g_hook = nullptr;
    
    printf("EXIT\n");
    fflush(stdout);
    
    return 0;
}
