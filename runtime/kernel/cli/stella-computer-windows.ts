import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveStatePath } from "./shared.js";
import { sanitizeStellaComputerSessionId } from "../tools/stella-computer-session.js";

type WinFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type WinElementRecord = {
  index: number;
  runtimeId?: number[];
  automationId?: string;
  name?: string;
  controlType?: string;
  localizedControlType?: string;
  className?: string;
  value?: string;
  nativeWindowHandle?: number;
  frame?: WinFrame | null;
  actions?: string[];
};

type WinSnapshot = {
  app: {
    name: string;
    bundleIdentifier?: string;
    pid: number;
  };
  windowTitle?: string;
  windowBounds?: WinFrame | null;
  screenshotPngBase64?: string | null;
  treeLines?: string[];
  focusedSummary?: string | null;
  selectedText?: string | null;
  elements?: WinElementRecord[];
};

type PsRequest = {
  tool: string;
  app?: string;
  element?: WinElementRecord;
  x?: number;
  y?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  click_count?: number;
  mouse_button?: string;
  action?: string;
  direction?: string;
  pages?: number;
  text?: string;
  key?: string;
  value?: string;
  windowBounds?: WinFrame | null;
};

type PsResponse = {
  ok: boolean;
  text?: string;
  error?: string;
  snapshot?: WinSnapshot;
};

const WINDOWS_RUNTIME_SCRIPT = String.raw`
param(
    [Parameter(Mandatory = $true)]
    [string]$OperationPath
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class StellaCUWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool PostMessage(IntPtr hWnd, UInt32 msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 msg, IntPtr wParam, string lParam);
}
"@

$WM_SETTEXT = 0x000C
$WM_MOUSEMOVE = 0x0200
$WM_LBUTTONDOWN = 0x0201
$WM_LBUTTONUP = 0x0202
$WM_RBUTTONDOWN = 0x0204
$WM_RBUTTONUP = 0x0205
$WM_MBUTTONDOWN = 0x0207
$WM_MBUTTONUP = 0x0208
$WM_MOUSEWHEEL = 0x020A
$WM_MOUSEHWHEEL = 0x020E
$WM_KEYDOWN = 0x0100
$WM_KEYUP = 0x0101
$WM_CHAR = 0x0102
$EM_SETSEL = 0x00B1
$EM_REPLACESEL = 0x00C2

function Test-EnvFlagEnabled([string]$name) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    $normalized = $value.Trim().ToLowerInvariant()
    return @("1", "true", "yes", "on") -contains $normalized
}

function New-Frame($x, $y, $width, $height) {
    if ($width -lt 0 -or $height -lt 0) { return $null }
    [pscustomobject]@{ x = [double]$x; y = [double]$y; width = [double]$width; height = [double]$height }
}

function ConvertTo-LParam([int]$x, [int]$y) {
    $packed = (($y -band 0xffff) -shl 16) -bor ($x -band 0xffff)
    [IntPtr]$packed
}

function ConvertTo-WheelWParam([int]$delta) {
    $packed = (($delta -band 0xffff) -shl 16)
    [IntPtr]$packed
}

function Get-WindowRectFrame([IntPtr]$hwnd) {
    $rect = New-Object StellaCUWin32+RECT
    if ([StellaCUWin32]::GetWindowRect($hwnd, [ref]$rect)) {
        return New-Frame $rect.Left $rect.Top ($rect.Right - $rect.Left) ($rect.Bottom - $rect.Top)
    }
    return $null
}

function Get-ElementFrame($element, $windowBounds) {
    try {
        $rect = $element.Current.BoundingRectangle
        if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { return $null }
        if ($null -ne $windowBounds) {
            return New-Frame ($rect.X - $windowBounds.x) ($rect.Y - $windowBounds.y) $rect.Width $rect.Height
        }
        return New-Frame $rect.X $rect.Y $rect.Width $rect.Height
    } catch {
        return $null
    }
}

function Get-ScreenPoint($localFrame, $windowBounds) {
    if ($null -eq $localFrame -or $null -eq $windowBounds) { return $null }
    [pscustomobject]@{
        x = [int][math]::Round($windowBounds.x + $localFrame.x + ($localFrame.width / 2))
        y = [int][math]::Round($windowBounds.y + $localFrame.y + ($localFrame.height / 2))
    }
}

function Send-MouseClick([IntPtr]$hwnd, [int]$screenX, [int]$screenY, [string]$button, [int]$count) {
    $point = New-Object StellaCUWin32+POINT
    $point.X = $screenX
    $point.Y = $screenY
    [void][StellaCUWin32]::ScreenToClient($hwnd, [ref]$point)
    $lParam = ConvertTo-LParam $point.X $point.Y

    $down = $WM_LBUTTONDOWN
    $up = $WM_LBUTTONUP
    $downFlag = 0x0001
    if ($button -eq "right") {
        $down = $WM_RBUTTONDOWN
        $up = $WM_RBUTTONUP
        $downFlag = 0x0002
    } elseif ($button -eq "middle") {
        $down = $WM_MBUTTONDOWN
        $up = $WM_MBUTTONUP
        $downFlag = 0x0010
    }

    $repeat = [math]::Max(1, $count)
    for ($i = 0; $i -lt $repeat; $i++) {
        [void][StellaCUWin32]::PostMessage($hwnd, $WM_MOUSEMOVE, [IntPtr]::Zero, $lParam)
        [void][StellaCUWin32]::PostMessage($hwnd, $down, [IntPtr]$downFlag, $lParam)
        Start-Sleep -Milliseconds 35
        [void][StellaCUWin32]::PostMessage($hwnd, $up, [IntPtr]::Zero, $lParam)
        Start-Sleep -Milliseconds 50
    }
}

function Send-Drag([IntPtr]$hwnd, [int]$fromX, [int]$fromY, [int]$toX, [int]$toY) {
    $start = New-Object StellaCUWin32+POINT
    $start.X = $fromX
    $start.Y = $fromY
    [void][StellaCUWin32]::ScreenToClient($hwnd, [ref]$start)
    $end = New-Object StellaCUWin32+POINT
    $end.X = $toX
    $end.Y = $toY
    [void][StellaCUWin32]::ScreenToClient($hwnd, [ref]$end)

    $steps = 12
    $startParam = ConvertTo-LParam $start.X $start.Y
    [void][StellaCUWin32]::PostMessage($hwnd, $WM_MOUSEMOVE, [IntPtr]::Zero, $startParam)
    [void][StellaCUWin32]::PostMessage($hwnd, $WM_LBUTTONDOWN, [IntPtr]1, $startParam)
    for ($i = 1; $i -le $steps; $i++) {
        $x = [int][math]::Round($start.X + (($end.X - $start.X) * $i / $steps))
        $y = [int][math]::Round($start.Y + (($end.Y - $start.Y) * $i / $steps))
        [void][StellaCUWin32]::PostMessage($hwnd, $WM_MOUSEMOVE, [IntPtr]1, (ConvertTo-LParam $x $y))
        Start-Sleep -Milliseconds 20
    }
    [void][StellaCUWin32]::PostMessage($hwnd, $WM_LBUTTONUP, [IntPtr]::Zero, (ConvertTo-LParam $end.X $end.Y))
}

function Send-Scroll([IntPtr]$hwnd, [int]$screenX, [int]$screenY, [string]$direction, [double]$pages) {
    $point = New-Object StellaCUWin32+POINT
    $point.X = $screenX
    $point.Y = $screenY
    [void][StellaCUWin32]::ScreenToClient($hwnd, [ref]$point)
    $lParam = ConvertTo-LParam $point.X $point.Y
    $delta = [int][math]::Round(120 * $pages)
    $message = $WM_MOUSEWHEEL
    if ($direction -eq "down" -or $direction -eq "right") { $delta = -1 * $delta }
    if ($direction -eq "left" -or $direction -eq "right") { $message = $WM_MOUSEHWHEEL }
    [void][StellaCUWin32]::PostMessage($hwnd, $message, (ConvertTo-WheelWParam $delta), $lParam)
}

function Send-Text([IntPtr]$hwnd, [string]$text) {
    foreach ($char in $text.ToCharArray()) {
        [void][StellaCUWin32]::PostMessage($hwnd, $WM_CHAR, [IntPtr][int][char]$char, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 8
    }
}

function Send-TextToEditHandle([IntPtr]$hwnd, [string]$text, $element) {
    if ($hwnd -eq [IntPtr]::Zero) { return $false }
    try {
        [void][StellaCUWin32]::SendMessage($hwnd, $EM_SETSEL, [IntPtr](-1), [IntPtr](-1))
        [void][StellaCUWin32]::SendMessage($hwnd, $EM_REPLACESEL, [IntPtr]1, $text)
        return $true
    } catch {}
    try {
        $current = ""
        if ($null -ne $element) { $current = Get-ElementValue $element }
        [void][StellaCUWin32]::SendMessage($hwnd, $WM_SETTEXT, [IntPtr]::Zero, ($current + $text))
        return $true
    } catch {
        return $false
    }
}

function Get-VirtualKey([string]$key) {
    $normalized = $key.ToLowerInvariant()
    $map = @{
        "return" = 0x0D; "enter" = 0x0D; "tab" = 0x09; "escape" = 0x1B; "esc" = 0x1B
        "backspace" = 0x08; "back_space" = 0x08; "delete" = 0x2E; "space" = 0x20
        "left" = 0x25; "up" = 0x26; "right" = 0x27; "down" = 0x28
        "home" = 0x24; "end" = 0x23; "page_up" = 0x21; "prior" = 0x21; "page_down" = 0x22; "next" = 0x22
    }
    if ($map.ContainsKey($normalized)) { return $map[$normalized] }
    if ($normalized -match "^f([1-9]|1[0-2])$") { return 0x70 + [int]$Matches[1] - 1 }
    if ($normalized -match "^kp_([0-9])$") { return 0x60 + [int]$Matches[1] }
    if ($normalized.Length -eq 1) {
        $code = [int][char]$normalized.ToUpperInvariant()[0]
        if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) { return $code }
    }
    throw "Unsupported key: $key"
}

function Send-Key([IntPtr]$hwnd, [string]$key) {
    $parts = $key -split "\+"
    $main = $parts[$parts.Length - 1]
    $modifiers = @()
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        switch ($parts[$i].ToLowerInvariant()) {
            "ctrl" { $modifiers += 0x11 }
            "control" { $modifiers += 0x11 }
            "shift" { $modifiers += 0x10 }
            "alt" { $modifiers += 0x12 }
            "super" { $modifiers += 0x5B }
            "win" { $modifiers += 0x5B }
            "cmd" { $modifiers += 0x5B }
        }
    }
    foreach ($modifier in $modifiers) {
        [void][StellaCUWin32]::PostMessage($hwnd, $WM_KEYDOWN, [IntPtr]$modifier, [IntPtr]::Zero)
    }
    $vk = Get-VirtualKey $main
    [void][StellaCUWin32]::PostMessage($hwnd, $WM_KEYDOWN, [IntPtr]$vk, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [void][StellaCUWin32]::PostMessage($hwnd, $WM_KEYUP, [IntPtr]$vk, [IntPtr]::Zero)
    [array]::Reverse($modifiers)
    foreach ($modifier in $modifiers) {
        [void][StellaCUWin32]::PostMessage($hwnd, $WM_KEYUP, [IntPtr]$modifier, [IntPtr]::Zero)
    }
}

function Resolve-App([string]$query) {
    $normalized = $query.Trim()
    $processQuery = $normalized
    if ($processQuery.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        $processQuery = $processQuery.Substring(0, $processQuery.Length - 4)
    }
    $processes = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 })
    $pidValue = 0
    if ([int]::TryParse($normalized, [ref]$pidValue)) {
        $match = $processes | Where-Object { $_.Id -eq $pidValue } | Select-Object -First 1
        if ($null -ne $match) { return $match }
    }
    $match = $processes | Where-Object {
        $_.ProcessName -ieq $processQuery -or
        "$($_.ProcessName).exe" -ieq $normalized -or
        $_.MainWindowTitle -ieq $normalized -or
        $_.MainWindowTitle -ilike "*$normalized*"
    } | Select-Object -First 1
    if ($null -ne $match) { return $match }
    if (Test-EnvFlagEnabled "STELLA_COMPUTER_WINDOWS_ALLOW_APP_LAUNCH") {
        try {
            $started = Start-Process -FilePath $normalized -PassThru
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Milliseconds 250
                $candidate = Get-Process -Id $started.Id -ErrorAction SilentlyContinue
                if ($null -ne $candidate -and $candidate.MainWindowHandle -ne 0) { return $candidate }
            }
        } catch {}
    }
    throw "appNotFound(\`"$query\`")"
}

function Get-MainElement($process) {
    if ($process.MainWindowHandle -ne 0) {
        return [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$process.MainWindowHandle)
    }
    $condition = New-Object Windows.Automation.PropertyCondition ([Windows.Automation.AutomationElement]::ProcessIdProperty), $process.Id
    $children = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)
    if ($children.Count -gt 0) { return $children.Item(0) }
    throw "No top-level UI Automation window is available for $($process.ProcessName). Run Stella in the signed-in desktop session."
}

function Get-WindowBounds($process, $element) {
    $hwnd = [IntPtr]$process.MainWindowHandle
    if ($hwnd -ne [IntPtr]::Zero) {
        $fromWin32 = Get-WindowRectFrame $hwnd
        if ($null -ne $fromWin32) { return $fromWin32 }
    }
    try {
        $rect = $element.Current.BoundingRectangle
        if (-not $rect.IsEmpty -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
            return New-Frame $rect.X $rect.Y $rect.Width $rect.Height
        }
    } catch {}
    return $null
}

function Get-PatternNames($element) {
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($pattern in $element.GetSupportedPatterns()) {
        $programmatic = $pattern.ProgrammaticName
        if ($programmatic -like "InvokePatternIdentifiers.Pattern") { $names.Add("Invoke") }
        elseif ($programmatic -like "TogglePatternIdentifiers.Pattern") { $names.Add("Toggle") }
        elseif ($programmatic -like "SelectionItemPatternIdentifiers.Pattern") { $names.Add("Select") }
        elseif ($programmatic -like "ExpandCollapsePatternIdentifiers.Pattern") {
            try {
                $state = $element.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Current.ExpandCollapseState
                if ($state -eq [Windows.Automation.ExpandCollapseState]::Collapsed) { $names.Add("Expand") }
                elseif ($state -eq [Windows.Automation.ExpandCollapseState]::Expanded) { $names.Add("Collapse") }
            } catch {
                $names.Add("Expand")
                $names.Add("Collapse")
            }
        }
        elseif ($programmatic -like "ScrollItemPatternIdentifiers.Pattern") { $names.Add("ScrollIntoView") }
        elseif ($programmatic -like "ScrollPatternIdentifiers.Pattern") { $names.Add("Scroll") }
        elseif ($programmatic -like "ValuePatternIdentifiers.Pattern") { $names.Add("SetValue") }
    }
    if ($names.Count -gt 0) { return @($names | Select-Object -Unique) }
    return @()
}

function Get-ElementString($element, [string]$propertyName) {
    try {
        $value = $element.Current.$propertyName
        if ($null -eq $value) { return "" }
        return [string]$value
    } catch {
        return ""
    }
}

function Get-ElementInt64($element, [string]$propertyName) {
    try { return [int64]$element.Current.$propertyName } catch { return 0 }
}

function Get-ElementControlTypeName($element) {
    try {
        $controlType = $element.Current.ControlType
        if ($null -eq $controlType) { return "" }
        return [string]$controlType.ProgrammaticName
    } catch {
        return ""
    }
}

function Get-ElementValue($element) {
    try {
        $valuePattern = $element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        $value = $valuePattern.Current.Value
        if ($null -eq $value) { return "" }
        $text = [string]$value
        if ($text.Length -gt 500) { return $text.Substring(0, 500) }
        return $text
    } catch {
        return ""
    }
}

function Get-ElementRecord($element, [int]$index, $windowBounds) {
    $frame = Get-ElementFrame $element $windowBounds
    $runtimeId = @()
    try { $runtimeId = @($element.GetRuntimeId()) } catch {}
    [pscustomobject]@{
        index = $index
        runtimeId = $runtimeId
        automationId = Get-ElementString $element "AutomationId"
        name = Get-ElementString $element "Name"
        controlType = Get-ElementControlTypeName $element
        localizedControlType = Get-ElementString $element "LocalizedControlType"
        className = Get-ElementString $element "ClassName"
        value = Get-ElementValue $element
        nativeWindowHandle = Get-ElementInt64 $element "NativeWindowHandle"
        frame = $frame
        actions = @(Get-PatternNames $element)
    }
}

function Get-ElementTitle($record) {
    if (-not [string]::IsNullOrWhiteSpace($record.name)) { return $record.name }
    if (-not [string]::IsNullOrWhiteSpace($record.automationId)) { return "ID: $($record.automationId)" }
    return ""
}

function Render-Tree($element, $windowBounds) {
    $script:records = New-Object System.Collections.Generic.List[object]
    $script:lines = New-Object System.Collections.Generic.List[string]
    $script:visited = New-Object System.Collections.Generic.HashSet[string]
    $script:nextIndex = 0
    $script:windowBounds = $windowBounds

    function Visit($node, [int]$depth) {
        if ($script:nextIndex -ge 500 -or $depth -gt 16) { return }
        $runtime = ""
        try { $runtime = (@($node.GetRuntimeId()) -join ".") } catch { $runtime = [guid]::NewGuid().ToString() }
        if (-not $script:visited.Add($runtime)) { return }

        $index = $script:nextIndex
        $script:nextIndex++
        $record = Get-ElementRecord $node $index $script:windowBounds
        $script:records.Add($record)

        $role = $record.localizedControlType
        if ([string]::IsNullOrWhiteSpace($role)) { $role = $record.controlType }
        $title = Get-ElementTitle $record
        $actionsSegment = ""
        if ($record.actions.Count -gt 0) { $actionsSegment = " Secondary Actions: " + ($record.actions -join ", ") }
        $valueSegment = ""
        if (-not [string]::IsNullOrWhiteSpace($record.value) -and $record.value -ne $title) {
            $safeValue = (($record.value -replace "\`r", "\\r") -replace "\`n", "\\n")
            $valueSegment = " Value: $safeValue"
        }
        $frameSegment = ""
        if ($null -ne $record.frame) {
            $frameSegment = " Frame: {{x: {0}, y: {1}, width: {2}, height: {3}}}" -f [int][math]::Round($record.frame.x), [int][math]::Round($record.frame.y), [int][math]::Round($record.frame.width), [int][math]::Round($record.frame.height)
        }
        $script:lines.Add(("\`t" * ($depth + 1)) + "$index $role $title$valueSegment$actionsSegment$frameSegment")

        try {
            $children = $node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $children.Count; $i++) { Visit $children.Item($i) ($depth + 1) }
        } catch {}
    }

    Visit $element 0
    [pscustomobject]@{ records = $script:records.ToArray(); lines = $script:lines.ToArray() }
}

function Capture-WindowPngBase64($bounds) {
    if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0) { return $null }
    try {
        $bitmap = New-Object System.Drawing.Bitmap ([int][math]::Round($bounds.width)), ([int][math]::Round($bounds.height))
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen([int][math]::Round($bounds.x), [int][math]::Round($bounds.y), 0, 0, $bitmap.Size)
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
        $bytes = $stream.ToArray()
        $stream.Dispose()
        return [Convert]::ToBase64String($bytes)
    } catch {
        return $null
    }
}

function Get-FocusedSummary($processId) {
    try {
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $focused -and $focused.Current.ProcessId -eq $processId) {
            $role = $focused.Current.LocalizedControlType
            $name = $focused.Current.Name
            if ([string]::IsNullOrWhiteSpace($name)) { return $role }
            return "$role $name"
        }
    } catch {}
    return $null
}

function Get-SelectedText($processId) {
    try {
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($null -eq $focused -or $focused.Current.ProcessId -ne $processId) { return $null }
        $textPattern = $focused.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)
        $selection = $textPattern.GetSelection()
        if ($selection.Count -gt 0) { return $selection.Item(0).GetText(2048) }
    } catch {}
    return $null
}

function Build-Snapshot([string]$query) {
    $process = Resolve-App $query
    $element = Get-MainElement $process
    $bounds = Get-WindowBounds $process $element
    $rendered = Render-Tree $element $bounds
    [pscustomobject]@{
        app = [pscustomobject]@{ name = $process.ProcessName; bundleIdentifier = $process.ProcessName; pid = [int]$process.Id }
        windowTitle = $process.MainWindowTitle
        windowBounds = $bounds
        screenshotPngBase64 = Capture-WindowPngBase64 $bounds
        treeLines = @($rendered.lines)
        focusedSummary = Get-FocusedSummary $process.Id
        selectedText = Get-SelectedText $process.Id
        elements = @($rendered.records)
    }
}

function List-Apps {
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($process in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object ProcessName, Id)) {
        $title = $process.MainWindowTitle
        if ([string]::IsNullOrWhiteSpace($title)) { $title = "untitled" }
        $lines.Add(("{0} -- {1} [running, pid={2}, window={3}]" -f $process.ProcessName, $process.ProcessName, $process.Id, $title))
    }
    return ($lines -join "\`n")
}

function Same-RuntimeId($left, $right) {
    if ($null -eq $left -or $null -eq $right -or $left.Count -ne $right.Count) { return $false }
    for ($i = 0; $i -lt $left.Count; $i++) {
        if ([int]$left[$i] -ne [int]$right[$i]) { return $false }
    }
    return $true
}

function Get-AllElements($root) {
    $items = New-Object System.Collections.Generic.List[object]
    $items.Add($root)
    try {
        $descendants = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        for ($i = 0; $i -lt $descendants.Count; $i++) { $items.Add($descendants.Item($i)) }
    } catch {}
    return $items.ToArray()
}

function Find-Element($process, $record) {
    if ($null -eq $record) { return $null }
    $root = Get-MainElement $process
    foreach ($element in (Get-AllElements $root)) {
        try {
            if (Same-RuntimeId @($element.GetRuntimeId()) @($record.runtimeId)) { return $element }
        } catch {}
    }
    foreach ($element in (Get-AllElements $root)) {
        try {
            $sameAutomationId = -not [string]::IsNullOrWhiteSpace($record.automationId) -and $element.Current.AutomationId -eq $record.automationId
            $sameName = -not [string]::IsNullOrWhiteSpace($record.name) -and $element.Current.Name -eq $record.name
            $sameType = $element.Current.ControlType.ProgrammaticName -eq $record.controlType
            if (($sameAutomationId -or $sameName) -and $sameType) { return $element }
        } catch {}
    }
    return $null
}

function Get-CurrentPatternOrNull($element, $pattern) {
    try { return $element.GetCurrentPattern($pattern) } catch { return $null }
}

function Invoke-PreferredClick($element) {
    $invoke = Get-CurrentPatternOrNull $element ([Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $invoke) { $invoke.Invoke(); return $true }
    $selection = Get-CurrentPatternOrNull $element ([Windows.Automation.SelectionItemPattern]::Pattern)
    if ($null -ne $selection) { $selection.Select(); return $true }
    $toggle = Get-CurrentPatternOrNull $element ([Windows.Automation.TogglePattern]::Pattern)
    if ($null -ne $toggle) { $toggle.Toggle(); return $true }
    return $false
}

function Invoke-SecondaryAction($element, [string]$action) {
    switch ($action.ToLowerInvariant()) {
        "invoke" { $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.InvokePattern]::Pattern); if ($null -ne $pattern) { $pattern.Invoke(); return } }
        "toggle" { $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.TogglePattern]::Pattern); if ($null -ne $pattern) { $pattern.Toggle(); return } }
        "select" { $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.SelectionItemPattern]::Pattern); if ($null -ne $pattern) { $pattern.Select(); return } }
        "expand" { $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ExpandCollapsePattern]::Pattern); if ($null -ne $pattern) { $pattern.Expand(); return } }
        "collapse" { $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ExpandCollapsePattern]::Pattern); if ($null -ne $pattern) { $pattern.Collapse(); return } }
        "scrollintoview" { $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ScrollItemPattern]::Pattern); if ($null -ne $pattern) { $pattern.ScrollIntoView(); return } }
        "setfocus" {
            if (-not (Test-EnvFlagEnabled "STELLA_COMPUTER_WINDOWS_ALLOW_FOCUS_ACTIONS")) {
                throw "SetFocus is disabled by default to avoid stealing user focus; set STELLA_COMPUTER_WINDOWS_ALLOW_FOCUS_ACTIONS=1 to enable it."
            }
            $element.SetFocus()
            return
        }
    }
    throw "$action is not a valid secondary action for $($operation.element.index)"
}

function Invoke-Scroll($element, [string]$direction, [double]$pages) {
    $scroll = Get-CurrentPatternOrNull $element ([Windows.Automation.ScrollPattern]::Pattern)
    if ($null -eq $scroll) { return $false }
    $horizontal = [Windows.Automation.ScrollAmount]::NoAmount
    $vertical = [Windows.Automation.ScrollAmount]::NoAmount
    if ($direction -eq "up") { $vertical = [Windows.Automation.ScrollAmount]::LargeDecrement }
    elseif ($direction -eq "down") { $vertical = [Windows.Automation.ScrollAmount]::LargeIncrement }
    elseif ($direction -eq "left") { $horizontal = [Windows.Automation.ScrollAmount]::LargeDecrement }
    elseif ($direction -eq "right") { $horizontal = [Windows.Automation.ScrollAmount]::LargeIncrement }
    $repeat = [math]::Max(1, [int][math]::Ceiling($pages))
    for ($i = 0; $i -lt $repeat; $i++) {
        $scroll.Scroll($horizontal, $vertical)
        Start-Sleep -Milliseconds 40
    }
    return $true
}

function Find-TextEntryElement($process) {
    try {
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $focused -and $focused.Current.ProcessId -eq $process.Id) {
            $focusedValue = Get-CurrentPatternOrNull $focused ([Windows.Automation.ValuePattern]::Pattern)
            if ($null -ne $focusedValue -and -not $focusedValue.Current.IsReadOnly) { return $focused }
        }
    } catch {}
    $root = Get-MainElement $process
    foreach ($element in (Get-AllElements $root)) {
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -eq $valuePattern -or $valuePattern.Current.IsReadOnly) { continue }
        $controlType = Get-ElementControlTypeName $element
        if ($controlType -like "*Edit*" -or $controlType -like "*Document*") { return $element }
    }
    foreach ($element in (Get-AllElements $root)) {
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) { return $element }
    }
    return $null
}

function Get-NativeWindowHandle($element) {
    $handle = Get-ElementInt64 $element "NativeWindowHandle"
    if ($handle -le 0) { return [IntPtr]::Zero }
    return [IntPtr]$handle
}

function Test-TextWindowHandleCandidate($process, $element) {
    if ($null -eq $element) { return $false }
    $handle = Get-NativeWindowHandle $element
    if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr]$process.MainWindowHandle) { return $false }
    $controlType = Get-ElementControlTypeName $element
    $className = Get-ElementString $element "ClassName"
    return ($controlType -like "*Edit*" -or $controlType -like "*Document*" -or $className -like "*Edit*" -or $className -like "*Rich*" -or $className -like "*Text*")
}

function Find-TextEntryWindowHandle($process, $preferredElement) {
    if (Test-TextWindowHandleCandidate $process $preferredElement) { return Get-NativeWindowHandle $preferredElement }
    $root = Get-MainElement $process
    foreach ($element in (Get-AllElements $root)) {
        if (-not (Test-TextWindowHandleCandidate $process $element)) { continue }
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) { return Get-NativeWindowHandle $element }
    }
    foreach ($element in (Get-AllElements $root)) {
        if (Test-TextWindowHandleCandidate $process $element) { return Get-NativeWindowHandle $element }
    }
    return [IntPtr]::Zero
}

function Invoke-TypeText($process, [string]$text) {
    $element = Find-TextEntryElement $process
    $targetHwnd = Find-TextEntryWindowHandle $process $element
    if ($targetHwnd -ne [IntPtr]::Zero -and (Send-TextToEditHandle $targetHwnd $text $element)) { return $true }
    if ($null -ne $element) {
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) {
            if (-not (Test-EnvFlagEnabled "STELLA_COMPUTER_WINDOWS_ALLOW_UIA_TEXT_FALLBACK")) {
                throw "UIA ValuePattern text fallback is disabled by default because it may bring the target app to the foreground; set STELLA_COMPUTER_WINDOWS_ALLOW_UIA_TEXT_FALLBACK=1 to enable it."
            }
            $current = ""
            try { $current = [string]$valuePattern.Current.Value } catch {}
            $valuePattern.SetValue($current + $text)
            return $true
        }
    }
    return $false
}

$operation = Get-Content -Raw -Path $OperationPath | ConvertFrom-Json

try {
    if ($operation.tool -eq "list_apps") {
        $response = [pscustomobject]@{ ok = $true; text = (List-Apps) }
    } elseif ($operation.tool -eq "get_app_state") {
        $response = [pscustomobject]@{ ok = $true; snapshot = (Build-Snapshot $operation.app) }
    } else {
        $process = Resolve-App $operation.app
        $hwnd = [IntPtr]$process.MainWindowHandle
        $windowBounds = $operation.windowBounds
        $element = Find-Element $process $operation.element

        switch ($operation.tool) {
            "click" {
                $handled = $false
                if ($null -ne $element -and $operation.mouse_button -ne "right" -and $operation.mouse_button -ne "middle") {
                    $handled = Invoke-PreferredClick $element
                }
                if (-not $handled) {
                    if ($null -ne $operation.element -and $null -ne $operation.element.frame) {
                        $point = Get-ScreenPoint $operation.element.frame $windowBounds
                    } else {
                        $point = [pscustomobject]@{ x = [int][math]::Round($windowBounds.x + [double]$operation.x); y = [int][math]::Round($windowBounds.y + [double]$operation.y) }
                    }
                    Send-MouseClick $hwnd $point.x $point.y $operation.mouse_button ([int]$operation.click_count)
                }
            }
            "perform_secondary_action" {
                if ($null -eq $element) { throw "unknown element_index '$($operation.element.index)'" }
                Invoke-SecondaryAction $element $operation.action
            }
            "scroll" {
                $handled = $false
                if ($null -ne $element) { $handled = Invoke-Scroll $element $operation.direction ([double]$operation.pages) }
                if (-not $handled) {
                    $point = Get-ScreenPoint $operation.element.frame $windowBounds
                    Send-Scroll $hwnd $point.x $point.y $operation.direction ([double]$operation.pages)
                }
            }
            "drag" {
                Send-Drag $hwnd ([int][math]::Round($windowBounds.x + [double]$operation.from_x)) ([int][math]::Round($windowBounds.y + [double]$operation.from_y)) ([int][math]::Round($windowBounds.x + [double]$operation.to_x)) ([int][math]::Round($windowBounds.y + [double]$operation.to_y))
            }
            "type_text" {
                if (-not (Invoke-TypeText $process $operation.text)) { Send-Text $hwnd $operation.text }
            }
            "press_key" {
                Send-Key $hwnd $operation.key
            }
            "set_value" {
                if ($null -eq $element) { throw "unknown element_index '$($operation.element.index)'" }
                $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
                if ($null -eq $valuePattern) { throw "Cannot set a value for an element that is not settable" }
                $valuePattern.SetValue($operation.value)
            }
            default {
                throw "unsupportedTool(\`"$($operation.tool)\`")"
            }
        }

        Start-Sleep -Milliseconds 120
        $response = [pscustomobject]@{ ok = $true; snapshot = (Build-Snapshot $operation.app) }
    }
} catch {
    $message = $_.Exception.Message
    if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) {
        $message = "$message at $($_.ScriptStackTrace)"
    }
    $response = [pscustomobject]@{ ok = $false; error = $message }
}

$response | ConvertTo-Json -Depth 50 -Compress
`.replace(/\\`/g, "`");

const stateDir = path.join(resolveStatePath(), "stella-computer");
const defaultSessionId = "manual";

const usage = `stella-computer - control Windows apps through UI Automation and Win32 messages

Usage:
  stella-computer list-apps
  stella-computer [--session ID] snapshot (--app NAME|--bundle-id ID|--pid PID) [--json]
  stella-computer [--session ID] get-state (--app NAME|--bundle-id ID|--pid PID) [--json]
  stella-computer [--session ID] click <element> [--app NAME] [--mouse-button left|right|middle] [--click-count N]
  stella-computer [--session ID] fill <element> <text> [--app NAME]
  stella-computer [--session ID] secondary-action <element> <action> [--app NAME]
  stella-computer [--session ID] scroll <element> <up|down|left|right> [--app NAME] [--pages N]
  stella-computer [--session ID] click-screenshot <x_px> <y_px> [--app NAME] [--mouse-button left|right|middle] [--click-count N]
  stella-computer [--session ID] drag-screenshot <from_x_px> <from_y_px> <to_x_px> <to_y_px> [--app NAME]
  stella-computer [--session ID] type <text> [--app NAME]
  stella-computer [--session ID] press <key> [--app NAME]

Notes:
  - snapshot writes element state under state/stella-computer/sessions/<session>/windows-targets/
  - actions reuse the last snapshot for the target app and refresh it after each action
  - Windows uses UI Automation patterns first and Win32 window messages as fallback
  - app launch, SetFocus, and UIA text fallback are opt-in via STELLA_COMPUTER_WINDOWS_ALLOW_* env flags
`;

const isTruthyEnv = (value: string | undefined) =>
  typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());

const stripOptionValue = (args: string[], flag: string) => {
  const nextArgs: string[] = [];
  let value: string | null = null;
  let missingValue = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === flag) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        missingValue = true;
        continue;
      }
      value = next;
      index += 1;
      continue;
    }
    nextArgs.push(arg);
  }
  return { value, args: nextArgs, missingValue };
};

const getSessionId = (sessionOverride?: string | null) =>
  sanitizeStellaComputerSessionId(sessionOverride) ??
  sanitizeStellaComputerSessionId(process.env.STELLA_COMPUTER_SESSION) ??
  defaultSessionId;

const sessionDir = (sessionId: string) =>
  path.join(stateDir, "sessions", sessionId, "windows-targets");

const normalizeTargetKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "default";

const targetStatePath = (sessionId: string, app: string) =>
  path.join(sessionDir(sessionId), normalizeTargetKey(app), "last-snapshot.json");

const targetScreenshotPath = (sessionId: string, app: string) =>
  path.join(sessionDir(sessionId), normalizeTargetKey(app), "last-screenshot.png");

const readSnapshot = (sessionId: string, app: string): WinSnapshot | null => {
  try {
    return JSON.parse(fs.readFileSync(targetStatePath(sessionId, app), "utf8")) as WinSnapshot;
  } catch {
    return null;
  }
};

const rememberSnapshot = (sessionId: string, app: string, snapshot: WinSnapshot) => {
  const aliases = new Set([
    app,
    snapshot.app.name,
    snapshot.app.bundleIdentifier,
    String(snapshot.app.pid),
  ].filter((value): value is string => Boolean(value)));

  const png = snapshot.screenshotPngBase64
    ? Buffer.from(snapshot.screenshotPngBase64, "base64")
    : null;

  for (const alias of aliases) {
    const statePath = targetStatePath(sessionId, alias);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(snapshot, null, 2));
    if (png) {
      fs.writeFileSync(targetScreenshotPath(sessionId, alias), png);
    }
  }
};

const runPowerShell = async (request: PsRequest): Promise<PsResponse> => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-computer-windows-"));
  const scriptPath = path.join(tempDir, "runtime.ps1");
  const operationPath = path.join(tempDir, "operation.json");
  try {
    fs.writeFileSync(scriptPath, WINDOWS_RUNTIME_SCRIPT, { mode: 0o600 });
    fs.writeFileSync(operationPath, JSON.stringify(request), { mode: 0o600 });

    const powershell = process.env.STELLA_COMPUTER_POWERSHELL ?? "powershell.exe";
    const child = spawn(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        operationPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const result = await new Promise<{ code: number | null; error?: Error; timedOut?: boolean }>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // best-effort
        }
        resolve({ code: 1, timedOut: true });
      }, 30_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        resolve({ code: 1, error });
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ code });
      });
    });

    if (result.timedOut) {
      throw new Error("Windows computer-use runtime timed out after 30s");
    }
    if (result.error) {
      throw result.error;
    }
    if (result.code !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `Windows computer-use runtime exited ${result.code}`);
    }

    try {
      return JSON.parse(stdout) as PsResponse;
    } catch (error) {
      throw new Error(
        `Windows computer-use runtime returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }: ${stdout.trim() || stderr.trim()}`,
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const appFromSnapshotArgs = (args: string[]) => {
  let nextArgs = args;
  const app = stripOptionValue(nextArgs, "--app");
  nextArgs = app.args;
  const bundle = stripOptionValue(nextArgs, "--bundle-id");
  nextArgs = bundle.args;
  const pid = stripOptionValue(nextArgs, "--pid");
  nextArgs = pid.args;
  if (app.missingValue || bundle.missingValue || pid.missingValue) {
    throw new Error("--app, --bundle-id, and --pid require a value.");
  }
  const target = app.value ?? bundle.value ?? pid.value;
  if (!target) {
    throw new Error("Windows computer-use requires --app, --bundle-id, or --pid.");
  }
  return { app: target, args: nextArgs };
};

const appFromActionArgs = (sessionId: string, args: string[]) => {
  let nextArgs = args;
  const app = stripOptionValue(nextArgs, "--app");
  nextArgs = app.args;
  const bundle = stripOptionValue(nextArgs, "--bundle-id");
  nextArgs = bundle.args;
  const pid = stripOptionValue(nextArgs, "--pid");
  nextArgs = pid.args;
  if (app.missingValue || bundle.missingValue || pid.missingValue) {
    throw new Error("--app, --bundle-id, and --pid require a value.");
  }
  const target = app.value ?? bundle.value ?? pid.value;
  if (target) {
    return { app: target, args: nextArgs };
  }

  const candidates: string[] = [];
  const root = sessionDir(sessionId);
  try {
    for (const entry of fs.readdirSync(root)) {
      const statePath = path.join(root, entry, "last-snapshot.json");
      if (fs.existsSync(statePath)) {
        candidates.push(statePath);
      }
    }
  } catch {
    // no cached snapshots
  }
  if (candidates.length === 1) {
    const snapshot = JSON.parse(fs.readFileSync(candidates[0]!, "utf8")) as WinSnapshot;
    return { app: snapshot.app.bundleIdentifier ?? snapshot.app.name, args: nextArgs };
  }
  throw new Error("Action commands require --app on Windows unless the session has exactly one cached snapshot.");
};

const getOptionValue = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
};

const splitWindowsArgs = (args: string[]) => {
  const positionals: string[] = [];
  const valueOptions = new Set([
    "--app",
    "--bundle-id",
    "--pid",
    "--mouse-button",
    "--click-count",
    "--pages",
    "--state",
  ]);
  const booleanOptions = new Set([
    "--allow-hid",
    "--raise",
    "--no-raise",
    "--no-screenshot",
    "--no-inline-screenshot",
    "--no-overlay",
    "--json",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (booleanOptions.has(arg)) {
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
};

const lookupElement = (snapshot: WinSnapshot, elementIndex: string) => {
  const index = Number(elementIndex);
  if (!Number.isInteger(index)) {
    throw new Error(`unknown element_index ${JSON.stringify(elementIndex)}`);
  }
  const record = snapshot.elements?.find((element) => element.index === index);
  if (!record) {
    throw new Error(`unknown element_index ${JSON.stringify(elementIndex)}`);
  }
  return record;
};

const requiredSnapshot = (sessionId: string, app: string) => {
  const snapshot = readSnapshot(sessionId, app);
  if (!snapshot) {
    throw new Error(`No app state is available for ${app}. Run computer_get_app_state before action tools.`);
  }
  return snapshot;
};

const frameImageBytes = (snapshot: WinSnapshot) =>
  snapshot.screenshotPngBase64 ? Buffer.from(snapshot.screenshotPngBase64, "base64") : null;

const formatScreenshotMarker = (sessionId: string, app: string, snapshot: WinSnapshot) => {
  if (!snapshot.screenshotPngBase64) return "";
  const bytes = frameImageBytes(snapshot);
  const path = targetScreenshotPath(sessionId, app);
  const dims = snapshot.windowBounds
    ? ` ${Math.round(snapshot.windowBounds.width)}x${Math.round(snapshot.windowBounds.height)}`
    : "";
  const sizeKb = bytes ? ` ${(bytes.byteLength / 1024).toFixed(0)}KB` : "";
  return `[stella-attach-image]${dims}${sizeKb} inline=image/png ${path}\n`;
};

const formatSnapshot = (sessionId: string, app: string, snapshot: WinSnapshot) => {
  process.stdout.write("<app_state>\n");
  const appRef = snapshot.app.bundleIdentifier || snapshot.app.name;
  process.stdout.write(`App=${appRef} (pid ${snapshot.app.pid})\n`);
  const title = snapshot.windowTitle || snapshot.app.name;
  process.stdout.write(`Window: "${title}", App: ${snapshot.app.name}.\n`);
  for (const line of snapshot.treeLines ?? []) {
    process.stdout.write(`${line}\n`);
  }
  if (snapshot.selectedText) {
    process.stdout.write(`\nSelected text: [${snapshot.selectedText}]\n`);
  } else if (snapshot.focusedSummary) {
    process.stdout.write(`\nThe focused UI element is ${snapshot.focusedSummary}.\n`);
  }
  process.stdout.write("</app_state>\n");
  process.stdout.write(formatScreenshotMarker(sessionId, app, snapshot));
};

const emitJson = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const runSnapshot = async (sessionId: string, app: string, jsonMode: boolean) => {
  const response = await runPowerShell({ tool: "get_app_state", app });
  if (!response.ok || !response.snapshot) {
    throw new Error(response.error || "Windows runtime did not return an app snapshot.");
  }
  rememberSnapshot(sessionId, app, response.snapshot);
  if (jsonMode) {
    emitJson(response.snapshot);
  } else {
    formatSnapshot(sessionId, app, response.snapshot);
  }
};

const runAction = async (
  sessionId: string,
  app: string,
  request: PsRequest,
  jsonMode: boolean,
) => {
  const response = await runPowerShell(request);
  if (!response.ok || !response.snapshot) {
    throw new Error(response.error || "Windows runtime did not return an app snapshot.");
  }
  rememberSnapshot(sessionId, app, response.snapshot);
  if (jsonMode) {
    emitJson(response.snapshot);
  } else {
    process.stdout.write(`${request.tool} completed.\n`);
    formatSnapshot(sessionId, app, response.snapshot);
  }
};

export const runWindowsStellaComputer = async (
  argv: string[],
  jsonMode: boolean,
  sessionOverride?: string | null,
) => {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(usage);
    return 0;
  }
  const sessionId = getSessionId(sessionOverride);
  const command = argv[0]!;
  const args = argv.slice(1);

  if (command === "list-apps") {
    const response = await runPowerShell({ tool: "list_apps" });
    if (!response.ok) {
      throw new Error(response.error || "Windows runtime failed to list apps.");
    }
    process.stdout.write(response.text?.trimEnd() || "No running top-level apps are visible to this Windows runtime.");
    process.stdout.write("\n");
    return 0;
  }

  if (command === "snapshot" || command === "get-state") {
    const target = appFromSnapshotArgs(args);
    await runSnapshot(sessionId, target.app, jsonMode);
    return 0;
  }

  if (command === "click") {
    const target = appFromActionArgs(sessionId, args);
    const element = splitWindowsArgs(target.args)[0];
    if (!element) throw new Error("click requires an element index.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    const record = lookupElement(snapshot, element);
    const button = getOptionValue(target.args, "--mouse-button") ?? "left";
    const countRaw = Number(getOptionValue(target.args, "--click-count") ?? "1");
    await runAction(sessionId, target.app, {
      tool: "click",
      app: target.app,
      element: record,
      mouse_button: button,
      click_count: Number.isFinite(countRaw) ? Math.max(1, Math.trunc(countRaw)) : 1,
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "click-screenshot") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    if (positionals.length < 2) throw new Error("click-screenshot requires x_px and y_px.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    const x = Number(positionals[0]);
    const y = Number(positionals[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("click-screenshot coordinates must be finite numbers.");
    }
    const button = getOptionValue(target.args, "--mouse-button") ?? "left";
    const countRaw = Number(getOptionValue(target.args, "--click-count") ?? "1");
    await runAction(sessionId, target.app, {
      tool: "click",
      app: target.app,
      x,
      y,
      mouse_button: button,
      click_count: Number.isFinite(countRaw) ? Math.max(1, Math.trunc(countRaw)) : 1,
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "drag-screenshot") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    if (positionals.length < 4) {
      throw new Error("drag-screenshot requires from_x_px, from_y_px, to_x_px, and to_y_px.");
    }
    const snapshot = requiredSnapshot(sessionId, target.app);
    const [fromX, fromY, toX, toY] = positionals.slice(0, 4).map(Number);
    if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
      throw new Error("drag-screenshot coordinates must be finite numbers.");
    }
    await runAction(sessionId, target.app, {
      tool: "drag",
      app: target.app,
      from_x: fromX,
      from_y: fromY,
      to_x: toX,
      to_y: toY,
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "fill") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    const [element, ...textParts] = positionals;
    if (!element) throw new Error("fill requires an element index.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    await runAction(sessionId, target.app, {
      tool: "set_value",
      app: target.app,
      element: lookupElement(snapshot, element),
      value: textParts.join(" "),
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "secondary-action" || command === "perform-secondary-action") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    const [element, action] = positionals;
    if (!element || !action) throw new Error("secondary-action requires an element index and action.");
    const snapshot = requiredSnapshot(sessionId, target.app);
    await runAction(sessionId, target.app, {
      tool: "perform_secondary_action",
      app: target.app,
      element: lookupElement(snapshot, element),
      action,
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "scroll") {
    const target = appFromActionArgs(sessionId, args);
    const positionals = splitWindowsArgs(target.args);
    const [element, direction] = positionals;
    if (!element || !direction) throw new Error("scroll requires an element index and direction.");
    if (!["up", "down", "left", "right"].includes(direction)) {
      throw new Error(`Invalid scroll direction: ${direction}`);
    }
    const snapshot = requiredSnapshot(sessionId, target.app);
    const pages = Number(getOptionValue(target.args, "--pages") ?? "1");
    await runAction(sessionId, target.app, {
      tool: "scroll",
      app: target.app,
      element: lookupElement(snapshot, element),
      direction,
      pages: Number.isFinite(pages) && pages > 0 ? pages : 1,
      windowBounds: snapshot.windowBounds ?? null,
    }, jsonMode);
    return 0;
  }

  if (command === "type") {
    const target = appFromActionArgs(sessionId, args);
    const text = splitWindowsArgs(target.args).join(" ");
    if (!text) throw new Error("type requires text.");
    requiredSnapshot(sessionId, target.app);
    await runAction(sessionId, target.app, {
      tool: "type_text",
      app: target.app,
      text,
    }, jsonMode);
    return 0;
  }

  if (command === "press") {
    const target = appFromActionArgs(sessionId, args);
    const key = splitWindowsArgs(target.args)[0];
    if (!key) throw new Error("press requires a key.");
    requiredSnapshot(sessionId, target.app);
    await runAction(sessionId, target.app, {
      tool: "press_key",
      app: target.app,
      key,
    }, jsonMode);
    return 0;
  }

  if (command === "doctor") {
    process.stdout.write(
      [
        "Windows runtime: UI Automation and Win32 window-message bridge are used when Stella runs in the signed-in desktop session.",
        `App launch opt-in: ${isTruthyEnv(process.env.STELLA_COMPUTER_WINDOWS_ALLOW_APP_LAUNCH) ? "enabled" : "disabled"}`,
        `Focus actions opt-in: ${isTruthyEnv(process.env.STELLA_COMPUTER_WINDOWS_ALLOW_FOCUS_ACTIONS) ? "enabled" : "disabled"}`,
        `UIA text fallback opt-in: ${isTruthyEnv(process.env.STELLA_COMPUTER_WINDOWS_ALLOW_UIA_TEXT_FALLBACK) ? "enabled" : "disabled"}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage}`);
};
