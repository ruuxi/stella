import { exec } from 'child_process'
import { promisify } from 'util'
import { getWindowInfoAtPoint } from './window-capture.js'

const execAsync = promisify(exec)
const TIMEOUT_MS = 5000
const MAX_TEXT_LENGTH = 16000

/**
 * Extract visible text content from the window at the given screen coordinates.
 * Uses UI Automation (Windows) or Accessibility API (macOS).
 */
export async function getWindowText(
  x: number,
  y: number,
  options?: { excludePids?: number[] },
): Promise<{ text: string; title: string; app: string } | null> {
  const windowInfo = await getWindowInfoAtPoint(x, y, options)
  if (!windowInfo) return null

  let text: string | null = null
  if (process.platform === 'win32') {
    text = await getWindowTextWindows(windowInfo.pid)
  } else if (process.platform === 'darwin') {
    text = await getWindowTextMacOS(windowInfo.process)
  }

  if (!text) return null
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH)
  }

  return { text, title: windowInfo.title, app: windowInfo.process }
}

/**
 * Windows: Use UI Automation via PowerShell to extract all visible text
 * from a window identified by PID.
 */
const getWindowTextWindows = async (pid: number): Promise<string | null> => {
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$targetPid = ${pid}
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid
)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
  [System.Windows.Automation.TreeScope]::Children, $condition
)
if ($window -eq $null) { exit }

# Try TextPattern on the window first (works for editors, document viewers)
try {
  $tp = $window.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
  if ($tp -ne $null) {
    $text = $tp.DocumentRange.GetText(32000)
    if ($text -and $text.Trim()) {
      Write-Output $text
      exit
    }
  }
} catch {}

# Walk the tree and collect text from all elements
$all = $window.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)
$seen = @{}
$sb = New-Object System.Text.StringBuilder
$count = 0
foreach ($el in $all) {
  if ($count -ge 500) { break }
  $name = $el.Current.Name
  if ($name -and $name.Trim() -and -not $seen.ContainsKey($name)) {
    $seen[$name] = $true
    [void]$sb.AppendLine($name)
    $count++
  }
  # Also try ValuePattern for editable content
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp -ne $null) {
      $val = $vp.Current.Value
      if ($val -and $val.Trim() -and -not $seen.ContainsKey($val)) {
        $seen[$val] = $true
        [void]$sb.AppendLine($val)
        $count++
      }
    }
  } catch {}
}
Write-Output $sb.ToString()
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -NoLogo -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * macOS: Use AppleScript with System Events to extract text from a window.
 * Requires Accessibility permissions.
 */
const getWindowTextMacOS = async (processName: string): Promise<string | null> => {
  // Use JXA (JavaScript for Automation) for faster, more reliable tree walking
  const script = `
function run() {
  const se = Application('System Events');
  const procs = se.processes.whose({ name: '${processName.replace(/'/g, "\\'")}' });
  if (procs.length === 0) return '';
  const proc = procs[0];
  if (proc.windows.length === 0) return '';
  const win = proc.windows[0];

  const texts = [];
  const seen = {};
  let count = 0;

  function add(s) {
    if (!s || typeof s !== 'string' || !s.trim()) return;
    if (seen[s]) return;
    seen[s] = true;
    texts.push(s.trim());
    count++;
  }

  function walk(el, depth) {
    if (count >= 500 || depth > 8) return;
    try { add(el.value()); } catch(e) {}
    try { add(el.name()); } catch(e) {}
    try { add(el.description()); } catch(e) {}
    try {
      const children = el.uiElements();
      const limit = Math.min(children.length, 200);
      for (let i = 0; i < limit; i++) {
        if (count >= 500) break;
        walk(children[i], depth + 1);
      }
    } catch(e) {}
  }

  walk(win, 0);
  return texts.join('\\n');
}
`
  try {
    const { stdout } = await execAsync(
      `osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`,
      { timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}
