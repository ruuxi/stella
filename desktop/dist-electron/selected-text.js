import { spawn, exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
const TIMEOUT_MS = 3000;
// Persistent PowerShell process for fast UI Automation queries
let psProcess = null;
let psReady = false;
let pendingResolve = null;
let outputBuffer = '';
const MARKER_START = '___STELLA_START___';
const MARKER_END = '___STELLA_END___';
/**
 * Initialize persistent PowerShell process at app startup
 * This loads UI Automation assemblies once and keeps them in memory
 */
export const initSelectedTextProcess = () => {
    if (process.platform !== 'win32')
        return;
    if (psProcess)
        return;
    psProcess = spawn('powershell', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    psProcess.stdout?.setEncoding('utf8');
    psProcess.stderr?.setEncoding('utf8');
    psProcess.stdout?.on('data', (data) => {
        outputBuffer += data;
        // Check if we have a complete response
        const startIdx = outputBuffer.indexOf(MARKER_START);
        const endIdx = outputBuffer.indexOf(MARKER_END);
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            const result = outputBuffer.slice(startIdx + MARKER_START.length, endIdx).trim();
            if (result) {
                console.log('[selected-text] Got result:', result.substring(0, 50) + '...');
            }
            outputBuffer = outputBuffer.slice(endIdx + MARKER_END.length);
            if (pendingResolve) {
                pendingResolve(result || null);
                pendingResolve = null;
            }
        }
    });
    psProcess.on('exit', (code) => {
        console.log('[selected-text] PowerShell process exited with code:', code);
        psProcess = null;
        psReady = false;
        if (pendingResolve) {
            pendingResolve(null);
            pendingResolve = null;
        }
    });
    psProcess.stderr?.on('data', (data) => {
        console.error('[selected-text] PowerShell stderr:', data);
    });
    // Load UI Automation assemblies once
    const initScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output "READY"
`;
    psProcess.stdin?.write(initScript + '\n');
    // Wait for READY signal
    const checkReady = () => {
        if (outputBuffer.includes('READY')) {
            outputBuffer = '';
            psReady = true;
            console.log('[selected-text] PowerShell process ready');
        }
        else {
            setTimeout(checkReady, 50);
        }
    };
    checkReady();
};
/**
 * Cleanup persistent PowerShell process on app quit
 */
export const cleanupSelectedTextProcess = () => {
    if (psProcess) {
        psProcess.stdin?.write('exit\n');
        psProcess.kill();
        psProcess = null;
    }
};
/**
 * Windows: Use UI Automation via persistent PowerShell to get selected text
 */
const getSelectedTextWindows = () => {
    return new Promise((resolve) => {
        if (!psProcess || !psReady) {
            console.log('[selected-text] PowerShell not ready:', { psProcess: !!psProcess, psReady });
            resolve(null);
            return;
        }
        // Only one in-flight query is supported against the persistent shell.
        // Resolve any stale waiter before starting a new one.
        if (pendingResolve) {
            pendingResolve(null);
            pendingResolve = null;
        }
        // eslint-disable-next-line prefer-const -- timeout and resolver are mutually referential
        let timeout;
        const resolver = (result) => {
            if (pendingResolve === resolver) {
                pendingResolve = null;
            }
            clearTimeout(timeout);
            resolve(result);
        };
        // Set a timeout in case PowerShell hangs
        timeout = setTimeout(() => {
            if (pendingResolve === resolver) {
                pendingResolve = null;
                resolve(null);
            }
        }, 500);
        pendingResolve = resolver;
        // Send command to get selected text
        const cmd = `
Write-Output "${MARKER_START}"
try {
  $element = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($element -ne $null) {
    $textPattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($textPattern -ne $null) {
      $selection = $textPattern.GetSelection()
      if ($selection.Length -gt 0) {
        Write-Output $selection[0].GetText(-1)
      }
    }
  }
} catch { }
Write-Output "${MARKER_END}"
`;
        psProcess.stdin?.write(cmd + '\n');
    });
};
/**
 * macOS: Use AppleScript with System Events to get selected text
 * Requires Accessibility permissions
 */
const getSelectedTextMacOS = async () => {
    const script = `
tell application "System Events"
  set frontProcess to first process whose frontmost is true
  try
    set selectedText to value of attribute "AXSelectedText" of (first window of frontProcess whose focused is true)
    if selectedText is not missing value and selectedText is not "" then
      return selectedText
    end if
  end try
  try
    set focusedElement to focused of frontProcess
    if focusedElement is not missing value then
      set selectedText to value of attribute "AXSelectedText" of focusedElement
      if selectedText is not missing value then
        return selectedText
      end if
    end if
  end try
end tell
return ""
`;
    try {
        const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: TIMEOUT_MS, encoding: 'utf8' });
        return stdout.trim() || null;
    }
    catch {
        return null;
    }
};
/**
 * Get currently selected text using platform-native APIs (Windows/macOS only)
 */
export const getSelectedText = async () => {
    try {
        if (process.platform === 'win32') {
            return await getSelectedTextWindows();
        }
        if (process.platform === 'darwin') {
            return await getSelectedTextMacOS();
        }
    }
    catch (error) {
        console.warn('Failed to get selected text:', error);
    }
    return null;
};
