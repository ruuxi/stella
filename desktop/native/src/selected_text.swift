// selected_text - Get currently selected text + screen bounds
// Usage: selected_text [--no-clipboard-fallback]
// Output: A single line of JSON to stdout (UTF-8):
//   {"text":"...","rect":{"x":123,"y":456,"w":210,"h":22}}
//   {"text":"..."}                         (text but no bounds available)
//   {}                                     (nothing selected)
//
// Strategy (in order):
//   1. Walk UP and DOWN the AX tree from the focused element looking
//      for `AXSelectedText` (cheap, no side effects).
//   2. Try the same against `AXFocusedWindow` and the system-wide
//      `AXFocusedUIElement`.
//   3. Pasteboard fallback: simulate Cmd+C, read NSPasteboard, restore
//      the original pasteboard contents. Covers apps that don't expose
//      `AXSelectedText` (Discord, Slack, terminals, custom-drawn text
//      views, many Electron apps). Skipped if the foreground app is
//      Stella itself or if `--no-clipboard-fallback` is passed.
//
// Build: swiftc -O -o selected_text src/selected_text.swift -framework ApplicationServices -framework AppKit -framework Carbon

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

// ────────────────────────────────────────────────────────────────────
// JSON helpers
// ────────────────────────────────────────────────────────────────────

func emitEmpty() {
    print("{}", terminator: "")
}

func jsonEscape(_ value: String) -> String {
    let data = try? JSONSerialization.data(
        withJSONObject: [value],
        options: [.fragmentsAllowed],
    )
    guard let data = data, let raw = String(data: data, encoding: .utf8) else {
        return "\"\""
    }
    let trimmed = raw
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    return trimmed
}

func emit(text: String, rect: CGRect?) {
    let escapedText = jsonEscape(text)
    if let rect = rect, rect.size.width > 0, rect.size.height > 0 {
        let x = Int(rect.origin.x.rounded())
        let y = Int(rect.origin.y.rounded())
        let w = Int(rect.size.width.rounded())
        let h = Int(rect.size.height.rounded())
        print(
            "{\"text\":\(escapedText),\"rect\":{\"x\":\(x),\"y\":\(y),\"w\":\(w),\"h\":\(h)}}",
            terminator: "",
        )
    } else {
        print("{\"text\":\(escapedText)}", terminator: "")
    }
}

// ────────────────────────────────────────────────────────────────────
// AX helpers
// ────────────────────────────────────────────────────────────────────

func axCopy(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return result == .success ? value : nil
}

func axCopyParam(_ element: AXUIElement, _ attribute: String, _ param: AnyObject) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyParameterizedAttributeValue(
        element,
        attribute as CFString,
        param as CFTypeRef,
        &value,
    )
    return result == .success ? value : nil
}

func readSelectedText(_ element: AXUIElement) -> String? {
    guard let value = axCopy(element, kAXSelectedTextAttribute), let text = value as? String else {
        return nil
    }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : text
}

func readSelectionBounds(_ element: AXUIElement) -> CGRect? {
    guard
        let rangeAXValue = axCopy(element, kAXSelectedTextRangeAttribute),
        CFGetTypeID(rangeAXValue) == AXValueGetTypeID()
    else {
        return nil
    }
    guard
        let rectAXValue = axCopyParam(
            element,
            kAXBoundsForRangeParameterizedAttribute,
            rangeAXValue,
        ),
        CFGetTypeID(rectAXValue) == AXValueGetTypeID()
    else {
        return nil
    }
    var rect = CGRect.zero
    let ok = withUnsafeMutablePointer(to: &rect) { ptr -> Bool in
        AXValueGetValue(rectAXValue as! AXValue, .cgRect, ptr)
    }
    if !ok { return nil }
    if rect.size.width <= 0 || rect.size.height <= 0 { return nil }
    return rect
}

struct AXSelection {
    let text: String
    let bounds: CGRect?
}

func readSelectionFrom(_ element: AXUIElement) -> AXSelection? {
    if let text = readSelectedText(element) {
        let bounds = readSelectionBounds(element)
        return AXSelection(text: text, bounds: bounds)
    }
    return nil
}

/// Walk up to `maxDepth` ancestors looking for an element that exposes
/// `AXSelectedText`. Mirrors the Windows binary's TreeWalker behavior —
/// browsers and many native apps expose selection on a parent of the
/// directly-focused leaf.
func walkUpForSelection(_ start: AXUIElement, maxDepth: Int = 12) -> AXSelection? {
    var current: AXUIElement? = start
    for _ in 0..<maxDepth {
        guard let node = current else { return nil }
        if let selection = readSelectionFrom(node) { return selection }
        current = (axCopy(node, kAXParentAttribute) as! AXUIElement?)
    }
    return nil
}

/// Walk children breadth-first up to `maxNodes` looking for selection.
/// Used when the focused element is a container that itself doesn't
/// expose selection but a descendant does (common for split views,
/// scroll views, Electron BrowserView wrappers).
func walkDownForSelection(_ root: AXUIElement, maxNodes: Int = 80) -> AXSelection? {
    var queue: [AXUIElement] = [root]
    var visited = 0
    while !queue.isEmpty && visited < maxNodes {
        let node = queue.removeFirst()
        visited += 1
        if let selection = readSelectionFrom(node) { return selection }
        if let children = axCopy(node, kAXChildrenAttribute) as? [AXUIElement] {
            queue.append(contentsOf: children)
        }
    }
    return nil
}

func systemWideFocusedElement() -> AXUIElement? {
    let systemWide = AXUIElementCreateSystemWide()
    return axCopy(systemWide, kAXFocusedUIElementAttribute) as! AXUIElement?
}

func appFocusedElement(_ app: AXUIElement) -> AXUIElement? {
    return axCopy(app, kAXFocusedUIElementAttribute) as! AXUIElement?
}

func appFocusedWindow(_ app: AXUIElement) -> AXUIElement? {
    return axCopy(app, kAXFocusedWindowAttribute) as! AXUIElement?
}

func tryAccessibilityChain(app: AXUIElement) -> AXSelection? {
    if let focused = systemWideFocusedElement() {
        if let s = walkUpForSelection(focused) { return s }
        if let s = walkDownForSelection(focused) { return s }
    }
    if let focused = appFocusedElement(app) {
        if let s = walkUpForSelection(focused) { return s }
        if let s = walkDownForSelection(focused) { return s }
    }
    if let window = appFocusedWindow(app) {
        if let s = readSelectionFrom(window) { return s }
        if let s = walkDownForSelection(window) { return s }
    }
    if let windows = axCopy(app, kAXWindowsAttribute) as? [AXUIElement] {
        for window in windows {
            if let s = readSelectionFrom(window) { return s }
        }
    }
    return nil
}

// ────────────────────────────────────────────────────────────────────
// Pasteboard fallback (Cmd+C with restore)
// ────────────────────────────────────────────────────────────────────

/// Snapshot of every item currently on the general pasteboard so we can
/// restore it after our synthetic Cmd+C without losing whatever the user
/// had on their clipboard.
struct PasteboardSnapshot {
    let items: [[String: Data]]
    let changeCount: Int
}

func snapshotPasteboard() -> PasteboardSnapshot {
    let pb = NSPasteboard.general
    var snapshots: [[String: Data]] = []
    if let items = pb.pasteboardItems {
        for item in items {
            var entry: [String: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) {
                    entry[type.rawValue] = data
                }
            }
            if !entry.isEmpty {
                snapshots.append(entry)
            }
        }
    }
    return PasteboardSnapshot(items: snapshots, changeCount: pb.changeCount)
}

func restorePasteboard(_ snapshot: PasteboardSnapshot) {
    let pb = NSPasteboard.general
    pb.clearContents()
    if snapshot.items.isEmpty { return }
    let restored: [NSPasteboardItem] = snapshot.items.map { entry in
        let item = NSPasteboardItem()
        for (type, data) in entry {
            item.setData(data, forType: NSPasteboard.PasteboardType(type))
        }
        return item
    }
    pb.writeObjects(restored)
}

func sendCommandC(target pid: pid_t) {
    guard let source = CGEventSource(stateID: .combinedSessionState) else {
        return
    }
    let kCmd: CGEventFlags = .maskCommand
    let cKey = CGKeyCode(kVK_ANSI_C)

    let down = CGEvent(keyboardEventSource: source, virtualKey: cKey, keyDown: true)
    down?.flags = kCmd
    let up = CGEvent(keyboardEventSource: source, virtualKey: cKey, keyDown: false)
    up?.flags = kCmd

    down?.postToPid(pid)
    up?.postToPid(pid)
}

func waitForPasteboardChange(initial: Int, timeoutMs: Int) -> Bool {
    let pb = NSPasteboard.general
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    while Date() < deadline {
        if pb.changeCount != initial {
            return true
        }
        Thread.sleep(forTimeInterval: 0.005)
    }
    return false
}

func tryPasteboardFallback(targetPid: pid_t) -> AXSelection? {
    let snapshot = snapshotPasteboard()
    sendCommandC(target: targetPid)
    let changed = waitForPasteboardChange(initial: snapshot.changeCount, timeoutMs: 250)

    var result: AXSelection? = nil
    if changed {
        let pb = NSPasteboard.general
        if let copied = pb.string(forType: .string) {
            let trimmed = copied.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                result = AXSelection(text: copied, bounds: nil)
            }
        }
    }

    // Always restore — even if the copy succeeded — so the user's
    // pasteboard is untouched.
    restorePasteboard(snapshot)
    return result
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

let args = CommandLine.arguments
let allowClipboardFallback = !args.contains("--no-clipboard-fallback")

guard let frontApp = NSWorkspace.shared.frontmostApplication else {
    emitEmpty()
    exit(0)
}

// Never invoke the clipboard fallback against ourselves — Stella's own
// renderer handles in-app selections via the React `AskStellaSelectionChip`,
// and synthesizing Cmd+C inside Electron would race with the renderer's
// own focus/selection state.
let frontPid = frontApp.processIdentifier
let isStellaFrontmost = frontPid == ProcessInfo.processInfo.processIdentifier
    || (frontApp.bundleIdentifier ?? "").contains("stella")
    || (frontApp.bundleIdentifier ?? "").contains("Electron")

let app = AXUIElementCreateApplication(frontPid)

if let selection = tryAccessibilityChain(app: app) {
    emit(text: selection.text, rect: selection.bounds)
    exit(0)
}

if allowClipboardFallback && !isStellaFrontmost {
    if let selection = tryPasteboardFallback(targetPid: frontPid) {
        emit(text: selection.text, rect: selection.bounds)
        exit(0)
    }
}

emitEmpty()
