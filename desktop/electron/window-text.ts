import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { getWindowInfoAtPoint } from './window-capture.js'

const execAsync = promisify(exec)
const TIMEOUT_MS = 6000
const MAX_TEXT_LENGTH = 16000
const MIN_USEFUL_TEXT = 50

/**
 * Extract visible text content from the window at the given screen coordinates.
 *
 * Uses element-at-point to find the UI element under the cursor, walks up the
 * accessibility tree to find a meaningful container, then extracts text from
 * that container's subtree — filtering out noisy roles (menu bars, toolbars,
 * scroll bars, status bars, etc.).
 *
 * Falls back to full-window extraction if the focused subtree yields too little text.
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
    text = await getWindowTextWindows(windowInfo.pid, x, y)
  } else if (process.platform === 'darwin') {
    text = await getWindowTextMacOS(windowInfo.process, x, y)
  }

  if (!text) return null
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH)
  }

  return { text, title: windowInfo.title, app: windowInfo.process }
}

/**
 * Windows: Use UI Automation via PowerShell.
 *
 * 1. AutomationElement.FromPoint → element under cursor
 * 2. Walk up parents (max 5 levels) to find a container (Pane, Document, Group, etc.)
 * 3. Extract text from container subtree, skipping noisy ControlTypes
 * 4. Fallback: full window walk with role filtering
 */
const getWindowTextWindows = async (pid: number, x: number, y: number): Promise<string | null> => {
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$targetPid = ${pid}
$cursorX = ${x}
$cursorY = ${y}
$MIN_TEXT = ${MIN_USEFUL_TEXT}
$RADIUS = 200

# Noisy control types to skip
$skipTypes = New-Object 'System.Collections.Generic.HashSet[System.Windows.Automation.ControlType]'
[void]$skipTypes.Add([System.Windows.Automation.ControlType]::MenuBar)
[void]$skipTypes.Add([System.Windows.Automation.ControlType]::Menu)
[void]$skipTypes.Add([System.Windows.Automation.ControlType]::MenuItem)
[void]$skipTypes.Add([System.Windows.Automation.ControlType]::ToolBar)
[void]$skipTypes.Add([System.Windows.Automation.ControlType]::StatusBar)
[void]$skipTypes.Add([System.Windows.Automation.ControlType]::ScrollBar)
[void]$skipTypes.Add([System.Windows.Automation.ControlType]::TitleBar)
[void]$skipTypes.Add([System.Windows.Automation.ControlType]::Thumb)

# Get the target window
$pidCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid
)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
  [System.Windows.Automation.TreeScope]::Children, $pidCondition
)
if ($window -eq $null) { exit }

# Try TextPattern first (works for editors, document viewers)
try {
  $tp = $window.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
  if ($tp -ne $null) {
    $text = $tp.DocumentRange.GetText(32000)
    if ($text -and $text.Trim().Length -ge $MIN_TEXT) {
      Write-Output $text
      exit
    }
  }
} catch {}

# Get all descendants once
$all = $window.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)

# --- Pass 1: spatial filter — only elements near the cursor ---
$seen = @{}
$sb = New-Object System.Text.StringBuilder
$count = 0
foreach ($el in $all) {
  if ($count -ge 500) { break }
  if ($skipTypes.Contains($el.Current.ControlType)) { continue }

  # Check bounding rect proximity
  try {
    $rect = $el.Current.BoundingRectangle
    if (-not $rect.IsEmpty) {
      $cx = $rect.Left + $rect.Width / 2
      $cy = $rect.Top + $rect.Height / 2
      if ([Math]::Abs($cx - $cursorX) -gt $RADIUS -or [Math]::Abs($cy - $cursorY) -gt $RADIUS) { continue }
    }
  } catch { continue }

  $name = $el.Current.Name
  if ($name -and $name.Trim() -and -not $seen.ContainsKey($name)) {
    $seen[$name] = $true
    [void]$sb.AppendLine($name)
    $count++
  }
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

$focused = $sb.ToString().Trim()
if ($focused.Length -ge $MIN_TEXT) {
  Write-Output $focused
  exit
}

# --- Pass 2 fallback: all text with role filtering (no spatial) ---
$seen2 = @{}
$sb2 = New-Object System.Text.StringBuilder
$count2 = 0
foreach ($el in $all) {
  if ($count2 -ge 500) { break }
  if ($skipTypes.Contains($el.Current.ControlType)) { continue }
  $name = $el.Current.Name
  if ($name -and $name.Trim() -and -not $seen2.ContainsKey($name)) {
    $seen2[$name] = $true
    [void]$sb2.AppendLine($name)
    $count2++
  }
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp -ne $null) {
      $val = $vp.Current.Value
      if ($val -and $val.Trim() -and -not $seen2.ContainsKey($val)) {
        $seen2[$val] = $true
        [void]$sb2.AppendLine($val)
        $count2++
      }
    }
  } catch {}
}
Write-Output $sb2.ToString().Trim()
`
  return new Promise<string | null>((resolve) => {
    const chunks: string[] = []
    const child = spawn('powershell', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => chunks.push(d))
    child.on('close', () => {
      const out = chunks.join('').trim()
      resolve(out || null)
    })
    child.on('error', () => resolve(null))
    const timer = setTimeout(() => { child.kill(); resolve(null) }, TIMEOUT_MS)
    child.on('close', () => clearTimeout(timer))
    child.stdin.write(script)
    child.stdin.end()
  })
}

/**
 * macOS: Use JXA (JavaScript for Automation) via osascript.
 *
 * 1. Drill down from the window by checking element bounds to find the
 *    deepest element containing the cursor.
 * 2. Walk back up the path to find a container role (AXGroup, AXWebArea, etc.)
 * 3. Extract text from that container, skipping noisy roles.
 * 4. Fallback: full window walk with role filtering.
 */
const getWindowTextMacOS = async (processName: string, x: number, y: number): Promise<string | null> => {
  const script = `
function run() {
  const se = Application('System Events');
  const procs = se.processes.whose({ name: '${processName.replace(/'/g, "\\'")}' });
  if (procs.length === 0) return '';
  const proc = procs[0];
  if (proc.windows.length === 0) return '';
  const win = proc.windows[0];

  const TX = ${x};
  const TY = ${y};

  const skipRoles = {
    'AXMenuBar':1, 'AXMenu':1, 'AXMenuItem':1, 'AXMenuButton':1,
    'AXToolbar':1, 'AXScrollBar':1, 'AXSplitter':1, 'AXGrowArea':1,
    'AXBusyIndicator':1
  };
  const containerRoles = {
    'AXGroup':1, 'AXScrollArea':1, 'AXSplitGroup':1, 'AXTabGroup':1,
    'AXList':1, 'AXTable':1, 'AXOutline':1, 'AXWebArea':1,
    'AXTextArea':1, 'AXSheet':1
  };

  // --- Drill down to find the element at the cursor ---
  function drillDown(root) {
    const path = [root];
    let current = root;
    for (let d = 0; d < 8; d++) {
      let found = false;
      try {
        const children = current.uiElements();
        const len = Math.min(children.length, 50);
        for (let i = 0; i < len; i++) {
          try {
            const pos = children[i].position();
            const sz = children[i].size();
            if (TX >= pos[0] && TX <= pos[0] + sz[0] &&
                TY >= pos[1] && TY <= pos[1] + sz[1]) {
              path.push(children[i]);
              current = children[i];
              found = true;
              break;
            }
          } catch(e) {}
        }
      } catch(e) {}
      if (!found) break;
    }
    return path;
  }

  // --- Walk a subtree and collect text, filtering noisy roles ---
  function collectText(root, maxItems) {
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
      if (count >= maxItems || depth > 8) return;
      try {
        const r = el.role();
        if (skipRoles[r]) return;
      } catch(e) {}
      try { add(el.value()); } catch(e) {}
      try { add(el.name()); } catch(e) {}
      try { add(el.description()); } catch(e) {}
      try {
        const children = el.uiElements();
        const limit = Math.min(children.length, 200);
        for (let i = 0; i < limit; i++) {
          if (count >= maxItems) break;
          walk(children[i], depth + 1);
        }
      } catch(e) {}
    }

    walk(root, 0);
    return texts.join('\\n');
  }

  // --- Element-at-point → container → extract ---
  const path = drillDown(win);
  if (path.length > 1) {
    // Walk backwards up the path to find a container role
    let containerIdx = -1;
    for (let i = path.length - 1; i >= 1; i--) {
      try {
        const r = path[i].role();
        if (containerRoles[r]) { containerIdx = i; break; }
      } catch(e) {}
    }

    // If no container found, use ~3 levels up from deepest
    if (containerIdx < 0) {
      containerIdx = Math.max(1, path.length - 4);
    }

    const text = collectText(path[containerIdx], 500);
    if (text.length >= ${MIN_USEFUL_TEXT}) return text;

    // Try one level higher
    if (containerIdx > 1) {
      const text2 = collectText(path[containerIdx - 1], 500);
      if (text2.length >= ${MIN_USEFUL_TEXT}) return text2;
    }
  }

  // --- Fallback: full window with role filtering ---
  return collectText(win, 500);
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
