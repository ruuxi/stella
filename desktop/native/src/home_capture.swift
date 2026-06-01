// home_capture - Capture a screenshot of an app's topmost window by pid.
// Used by the Stella home suggestion chip strip when the user clicks an
// app suggestion: the chip attaches eagerly with metadata, then this
// helper captures the actual window screenshot in the background and the
// renderer patches the chat context when the result lands.
//
// Usage:
//   home_capture --pid=<pid> --screenshot=<output_path.png>
//
// Output (JSON to stdout):
//   {"title":"…","process":"App","pid":123,"bounds":{"x":0,"y":0,"width":W,"height":H},"axTree":"…"}
// or:
//   {"error":"no window for pid"}
//
// The screenshot is written to `output_path.png` if requested AND a
// matching window was found. The file is left untouched on error so the
// caller can detect failure by stat'ing the file size.
//
// Window-selection strategy:
//   Pass 1 (visible apps) — `optionOnScreenOnly + layer==0`, mirrors the
//     long-standing `window_info` behavior so on-Space windows are picked
//     correctly and we don't accidentally match tooltips, IME bars, or
//     other transient chrome the app owns.
//   Pass 2 (off-Space fallback) — only runs if Pass 1 found nothing.
//     Drops `optionOnScreenOnly` so windows on other macOS Spaces are
//     reachable, but still enforces `layer<=0` and a minimum size to
//     filter out the chrome / floating UI elements that off-screen apps
//     also report. SC capture uses `onScreenWindowsOnly: false` so
//     off-Space windows are still capturable.
//
// Build: swiftc -O -o out/darwin/home_capture src/home_capture.swift \
//   -framework AppKit -framework CoreGraphics -framework Foundation \
//   -framework ApplicationServices -framework ScreenCaptureKit

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

func parsePid(_ args: [String]) -> Int? {
    let prefix = "--pid="
    for arg in args {
        guard arg.hasPrefix(prefix) else { continue }
        let payload = String(arg.dropFirst(prefix.count))
        if let value = Int(payload), value > 0 { return value }
    }
    return nil
}

func parseScreenshotPath(_ args: [String]) -> String? {
    let prefix = "--screenshot="
    for arg in args {
        guard arg.hasPrefix(prefix) else { continue }
        return String(arg.dropFirst(prefix.count))
    }
    return nil
}

func escapeJson(_ s: String) -> String {
    var out = ""
    for scalar in s.unicodeScalars {
        switch scalar.value {
        case 0x22: out += "\\\""
        case 0x5C: out += "\\\\"
        case 0x08: out += "\\b"
        case 0x0C: out += "\\f"
        case 0x0A: out += "\\n"
        case 0x0D: out += "\\r"
        case 0x09: out += "\\t"
        case 0x00..<0x20:
            out += String(format: "\\u%04X", scalar.value)
        default:
            out.append(String(scalar))
        }
    }
    return out
}

struct WindowMatch {
    let windowID: CGWindowID
    let title: String
    let ownerName: String
    let bounds: (x: Double, y: Double, w: Double, h: Double)
}

struct AXRenderResult {
    let text: String
    let nodeCount: Int
}

let maxAXDepth = 32
let maxAXNodes = 1500
let maxAXTextCharacters = 120_000

func findWindow(
    forPid pid: Int,
    options: CGWindowListOption,
    enforceMinimumSize: Bool
) -> WindowMatch? {
    guard let windowList = CGWindowListCopyWindowInfo(
        options,
        kCGNullWindowID
    ) as? [[String: Any]] else {
        return nil
    }

    var best: (match: WindowMatch, score: Double)?

    // CGWindowList is front-to-back, but Electron/CEF apps often expose a
    // small layer-0 title strip before the real content window. Score all
    // candidates so normal-sized windows win without losing frontmost order
    // among comparable windows.
    for (order, window) in windowList.enumerated() {
        guard let ownerPid = window[kCGWindowOwnerPID as String] as? Int else { continue }
        guard ownerPid == pid else { continue }

        // Always exclude chrome (Dock=20, MenuBar=24, StatusItems=25, etc.).
        // Layer 0 is normal-priority window content. Negative layers are
        // utility/drawer; we keep them.
        if let layer = window[kCGWindowLayer as String] as? Int, layer > 0 { continue }

        guard let boundsDict = window[kCGWindowBounds as String] as? [String: CGFloat],
              let wx = boundsDict["X"],
              let wy = boundsDict["Y"],
              let ww = boundsDict["Width"],
              let wh = boundsDict["Height"] else { continue }
        guard ww > 0, wh > 0 else { continue }

        // Off-screen apps sometimes still report their tooltips, IME
        // bars, etc. with layer 0. Filter to "real" window shapes (>=100
        // px each side) when we're in fallback mode.
        if enforceMinimumSize, ww < 100 || wh < 100 { continue }

        let title = (window[kCGWindowName as String] as? String) ?? ""
        let ownerName = (window[kCGWindowOwnerName as String] as? String) ?? ""
        let windowID = (window[kCGWindowNumber as String] as? CGWindowID) ?? 0

        let match = WindowMatch(
            windowID: windowID,
            title: title,
            ownerName: ownerName,
            bounds: (Double(wx), Double(wy), Double(ww), Double(wh))
        )
        let area = Double(ww * wh)
        let isNormalWindow = ww >= 100 && wh >= 100
        let titleScore = title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.0 : 250.0
        let sizeScore = isNormalWindow ? 100_000.0 : 0.0
        let areaScore = min(area / 1000.0, 20_000.0)
        let frontScore = max(0.0, 10_000.0 - Double(order))
        let score = sizeScore + areaScore + frontScore + titleScore
        if best == nil || score > best!.score {
            best = (match, score)
        }
    }

    return best?.match
}

func axCopy(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return result == .success ? value : nil
}

func axSettable(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var settable = DarwinBoolean(false)
    let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
    return result == .success ? settable.boolValue : nil
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let raw = axCopy(element, attribute) else { return nil }
    if let text = raw as? String { return cleanAXText(text) }
    if let url = raw as? URL { return cleanAXText(url.absoluteString) }
    if let number = raw as? NSNumber { return number.stringValue }
    if CFGetTypeID(raw) == AXValueGetTypeID() { return nil }
    return cleanAXText(String(describing: raw))
}

func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    guard let raw = axCopy(element, attribute) else { return nil }
    if let value = raw as? Bool { return value }
    if let value = raw as? NSNumber { return value.boolValue }
    return nil
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    guard let raw = axCopy(element, attribute),
          CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = unsafeBitCast(raw, to: AXValue.self)
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    guard let raw = axCopy(element, attribute),
          CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = unsafeBitCast(raw, to: AXValue.self)
    var size = CGSize.zero
    return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let point = axPoint(element, kAXPositionAttribute as String),
          let size = axSize(element, kAXSizeAttribute as String) else { return nil }
    return CGRect(origin: point, size: size)
}

func coerceElement(_ raw: AnyObject?) -> AXUIElement? {
    guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(raw, to: AXUIElement.self)
}

func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    coerceElement(axCopy(element, attribute))
}

func axElementArray(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
    guard let raw = axCopy(element, attribute) else { return [] }
    if let elements = raw as? [AXUIElement] { return elements }
    guard let array = raw as? [AnyObject] else { return [] }
    return array.compactMap(coerceElement)
}

func elementHash(_ element: AXUIElement) -> Int {
    Int(bitPattern: CFHash(element))
}

func cleanAXText(_ text: String) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "" }
    return trimmed
        .components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }
        .joined(separator: " ")
}

func truncate(_ text: String, maxLength: Int) -> String {
    if text.count <= maxLength { return text }
    let index = text.index(text.startIndex, offsetBy: maxLength)
    return String(text[..<index]) + "…"
}

func humanRole(_ role: String) -> String {
    let stripped = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
    var out = ""
    for scalar in stripped.unicodeScalars {
        let ch = Character(scalar)
        if !out.isEmpty, CharacterSet.uppercaseLetters.contains(scalar) {
            out.append(" ")
        }
        out.append(ch)
    }
    return out.lowercased()
}

func sameWindowTitle(_ lhs: String?, _ rhs: String?) -> Bool {
    let a = (lhs ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let b = (rhs ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return !a.isEmpty && a == b
}

func frameScore(_ frame: CGRect?, match: WindowMatch) -> Double {
    guard let frame else { return 0 }
    let dx = abs(Double(frame.origin.x) - match.bounds.x)
    let dy = abs(Double(frame.origin.y) - match.bounds.y)
    let dw = abs(Double(frame.size.width) - match.bounds.w)
    let dh = abs(Double(frame.size.height) - match.bounds.h)
    let delta = dx + dy + dw + dh
    return max(0, 8_000 - delta)
}

func setManualAccessibility(_ app: AXUIElement) {
    _ = AXUIElementSetAttributeValue(
        app,
        "AXManualAccessibility" as CFString,
        kCFBooleanTrue
    )
}

func candidateAXWindows(for app: AXUIElement) -> [AXUIElement] {
    var results: [AXUIElement] = []
    var seen = Set<Int>()

    func append(_ element: AXUIElement?) {
        guard let element else { return }
        let key = elementHash(element)
        if seen.contains(key) { return }
        seen.insert(key)
        AXUIElementSetMessagingTimeout(element, 0.4)
        results.append(element)
    }

    append(axElement(app, kAXFocusedWindowAttribute as String))
    append(axElement(app, kAXMainWindowAttribute as String))
    for window in axElementArray(app, kAXWindowsAttribute as String) {
        append(window)
    }

    return results
}

func findAXWindow(for app: AXUIElement, match: WindowMatch) -> AXUIElement? {
    let windows = candidateAXWindows(for: app)
    if windows.isEmpty { return nil }

    var best: (window: AXUIElement, score: Double)?
    for (order, window) in windows.enumerated() {
        let role = axString(window, kAXRoleAttribute as String) ?? ""
        let title = axString(window, kAXTitleAttribute as String)
        let frame = axFrame(window)
        var score = max(0.0, 1_000.0 - Double(order))
        if role == (kAXWindowRole as String) { score += 500 }
        if sameWindowTitle(title, match.title) { score += 10_000 }
        score += frameScore(frame, match: match)
        if let frame, frame.width >= 100, frame.height >= 100 { score += 1_000 }
        if best == nil || score > best!.score {
            best = (window, score)
        }
    }
    return best?.window
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    let attributes = [
        kAXChildrenAttribute as String,
        "AXVisibleChildren",
        "AXContents",
        "AXRows",
        "AXColumns",
    ]
    var results: [AXUIElement] = []
    var seen = Set<Int>()
    for attribute in attributes {
        for child in axElementArray(element, attribute) {
            let key = elementHash(child)
            if seen.contains(key) { continue }
            seen.insert(key)
            AXUIElementSetMessagingTimeout(child, 0.25)
            results.append(child)
        }
    }
    return results
}

func primaryLabel(title: String?, description: String?, value: String?, placeholder: String?) -> String? {
    for candidate in [title, description, value, placeholder] {
        if let text = candidate, !text.isEmpty {
            return text
        }
    }
    return nil
}

func appendExtra(_ extras: inout [String], label: String, value: String?, excluding excluded: Set<String>) {
    guard let value, !value.isEmpty else { return }
    if excluded.contains(value) { return }
    extras.append("\(label): \(truncate(value, maxLength: 140))")
}

func renderAXElement(
    _ element: AXUIElement,
    depth: Int,
    nextIndex: inout Int,
    visited: inout Set<Int>,
    lines: inout [String]
) {
    if depth > maxAXDepth || nextIndex > maxAXNodes { return }
    let key = elementHash(element)
    if visited.contains(key) { return }
    visited.insert(key)

    let role = axString(element, kAXRoleAttribute as String) ?? "AXElement"
    let title = axString(element, kAXTitleAttribute as String)
    let description = axString(element, kAXDescriptionAttribute as String)
    let value = axString(element, kAXValueAttribute as String)
    let placeholder = axString(element, "AXPlaceholderValue")
    let help = axString(element, kAXHelpAttribute as String)
    let identifier = axString(element, kAXIdentifierAttribute as String)
    let url = axString(element, "AXURL")
    let selected = axBool(element, kAXSelectedAttribute as String)
    let focused = axBool(element, kAXFocusedAttribute as String)
    let enabled = axBool(element, kAXEnabledAttribute as String)
    let expanded = axBool(element, "AXExpanded")
    let settable = axSettable(element, kAXValueAttribute as String)

    let label = primaryLabel(
        title: title,
        description: description,
        value: value,
        placeholder: placeholder
    )
    var excluded = Set<String>()
    if let label { excluded.insert(label) }
    var extras: [String] = []
    appendExtra(&extras, label: "Description", value: description, excluding: excluded)
    appendExtra(&extras, label: "Value", value: value, excluding: excluded)
    appendExtra(&extras, label: "Placeholder", value: placeholder, excluding: excluded)
    appendExtra(&extras, label: "Help", value: help, excluding: excluded)
    appendExtra(&extras, label: "ID", value: identifier, excluding: excluded)
    appendExtra(&extras, label: "URL", value: url, excluding: excluded)

    var flags: [String] = []
    if focused == true { flags.append("focused") }
    if selected == true { flags.append("selected") }
    if enabled == false { flags.append("disabled") }
    if expanded == true { flags.append("expanded") }
    if expanded == false { flags.append("collapsed") }
    if settable == true { flags.append("settable") }

    let childElements = axChildren(element)
    let isEmptyContainer =
        (role == (kAXGroupRole as String) ||
         role == (kAXScrollAreaRole as String) ||
         role == "AXSplitterGroup") &&
        label == nil &&
        extras.isEmpty &&
        flags.isEmpty

    if isEmptyContainer, childElements.count == 1 {
        renderAXElement(
            childElements[0],
            depth: depth,
            nextIndex: &nextIndex,
            visited: &visited,
            lines: &lines
        )
        return
    }

    if !isEmptyContainer {
        let id = nextIndex
        nextIndex += 1
        let indent = String(repeating: "\t", count: depth)
        var line = "\(indent)\(id) \(humanRole(role))"
        if !flags.isEmpty {
            line += " [\(flags.joined(separator: ", "))]"
        }
        if let label {
            line += " \(truncate(label, maxLength: 160))"
        }
        if !extras.isEmpty {
            line += label == nil ? " \(extras.joined(separator: ", "))" : ", \(extras.joined(separator: ", "))"
        }
        lines.append(line)
    }

    for child in childElements {
        renderAXElement(
            child,
            depth: isEmptyContainer ? depth : depth + 1,
            nextIndex: &nextIndex,
            visited: &visited,
            lines: &lines
        )
        if nextIndex > maxAXNodes { break }
    }
}

func renderAccessibilityTree(forPid pid: Int, match: WindowMatch) -> AXRenderResult? {
    guard AXIsProcessTrusted() else { return nil }
    let app = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetMessagingTimeout(app, 0.5)
    setManualAccessibility(app)

    func renderOnce() -> AXRenderResult {
        let roots: [AXUIElement]
        if let window = findAXWindow(for: app, match: match) {
            roots = [window]
        } else {
            roots = [app]
        }

        var visited = Set<Int>()
        var lines: [String] = []
        var nextIndex = 1
        for root in roots {
            renderAXElement(
                root,
                depth: 0,
                nextIndex: &nextIndex,
                visited: &visited,
                lines: &lines
            )
        }

        var header = "<app_state>\nApp=\(match.ownerName) (pid \(pid))"
        if !match.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            header += "\nWindow: \"\(match.title)\", App: \(match.ownerName)."
        }
        let body = lines.joined(separator: "\n")
        let text = "\(header)\n\(body)\n</app_state>"
        return AXRenderResult(text: truncate(text, maxLength: maxAXTextCharacters), nodeCount: max(0, nextIndex - 1))
    }

    var result = renderOnce()
    if result.nodeCount < 50 {
        setManualAccessibility(app)
        Thread.sleep(forTimeInterval: 0.30)
        let retried = renderOnce()
        if retried.nodeCount > result.nodeCount {
            result = retried
        }
    }
    return result
}

let args = Array(CommandLine.arguments.dropFirst())

guard let pid = parsePid(args) else {
    fputs("Usage: home_capture --pid=<pid> [--screenshot=<path.png>]\n", stderr)
    exit(1)
}

let screenshotPath = parseScreenshotPath(args)

// Pass 1: on-screen, strict (matches legacy window_info behavior). This
// is the common case for any app whose window is on the user's current
// macOS Space.
var match = findWindow(
    forPid: pid,
    options: [.optionOnScreenOnly, .excludeDesktopElements],
    enforceMinimumSize: false
)

// Pass 2: drop on-screen filter so off-Space windows are reachable. Apply
// the minimum-size guard to keep stray UI elements out of the result.
if match == nil {
    match = findWindow(
        forPid: pid,
        options: [.excludeDesktopElements],
        enforceMinimumSize: true
    )
}

guard let match else {
    print("{\"error\":\"no window for pid\"}")
    exit(0)
}

let bx = Int(match.bounds.x)
let by = Int(match.bounds.y)
let bw = Int(match.bounds.w)
let bh = Int(match.bounds.h)
let axTree = renderAccessibilityTree(forPid: pid, match: match)?.text ?? ""

let json = """
{"title":"\(escapeJson(match.title))","process":"\(escapeJson(match.ownerName))","pid":\(pid),"bounds":{"x":\(bx),"y":\(by),"width":\(bw),"height":\(bh)},"axTree":"\(escapeJson(axTree))"}
"""
print(json.trimmingCharacters(in: .whitespacesAndNewlines))

if let ssPath = screenshotPath, match.windowID != 0 {
    let captureWidth = bw
    let captureHeight = bh
    let semaphore = DispatchSemaphore(value: 0)
    Task.detached {
        defer { semaphore.signal() }
        do {
            // `onScreenWindowsOnly: false` so we can capture windows on
            // other macOS Spaces — ScreenCaptureKit renders their
            // last-known framebuffer.
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false
            )
            guard let scWindow = content.windows.first(where: { $0.windowID == match.windowID })
            else { return }

            let filter = SCContentFilter(desktopIndependentWindow: scWindow)
            let config = SCStreamConfiguration()
            config.width = captureWidth
            config.height = captureHeight

            let cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: config
            )
            let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
            if let pngData = bitmapRep.representation(using: .png, properties: [:]) {
                try? pngData.write(to: URL(fileURLWithPath: ssPath))
            }
        } catch {}
    }
    semaphore.wait()
}

exit(0)
