// selected_text - Get currently selected text via Accessibility API
// Usage: selected_text (no arguments)
// Output: Raw selected text to stdout (UTF-8), empty if nothing selected
//
// Queries AXSelectedText on the focused element of the frontmost application.
//
// Build: swiftc -O -o selected_text src/selected_text.swift -framework ApplicationServices -framework AppKit

import AppKit
import ApplicationServices

// Get the frontmost app's PID
guard let frontApp = NSWorkspace.shared.frontmostApplication else { exit(0) }
let pid = frontApp.processIdentifier

let app = AXUIElementCreateApplication(pid)

// Get the focused element
var focusedValue: AnyObject?
let focusedResult = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedValue)

if focusedResult == .success, let focused = focusedValue {
    // Try AXSelectedText on focused element
    var selectedValue: AnyObject?
    let selectedResult = AXUIElementCopyAttributeValue(focused as! AXUIElement, kAXSelectedTextAttribute as CFString, &selectedValue)

    if selectedResult == .success, let text = selectedValue as? String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            print(trimmed, terminator: "")
            exit(0)
        }
    }
}

// Fallback: try AXSelectedText on the first window
var windowsValue: AnyObject?
let windowsResult = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsValue)

if windowsResult == .success, let windows = windowsValue as? [AXUIElement], !windows.isEmpty {
    var selectedValue: AnyObject?
    let selectedResult = AXUIElementCopyAttributeValue(windows[0], kAXSelectedTextAttribute as CFString, &selectedValue)

    if selectedResult == .success, let text = selectedValue as? String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            print(trimmed, terminator: "")
        }
    }
}
