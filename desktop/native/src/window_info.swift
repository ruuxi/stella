// window_info - Returns JSON info about the window at a given screen point
// Usage: window_info <x> <y> [--exclude-pids=1,2,3] [--screenshot=path.png] [--set-bounds=x,y,w,h]
// Build: swiftc -O -o window_info src/window_info.swift -framework CoreGraphics -framework AppKit
// Output: {"title":"...","process":"...","pid":123,"bounds":{"x":0,"y":0,"width":800,"height":600}}

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

func parseExcludedPids(_ args: ArraySlice<String>) -> Set<Int> {
    let prefix = "--exclude-pids="
    var pids = Set<Int>()

    for arg in args {
        guard arg.hasPrefix(prefix) else { continue }
        let payload = String(arg.dropFirst(prefix.count))
        for rawValue in payload.split(separator: ",") {
            let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let pid = Int(value), pid > 0 else { continue }
            pids.insert(pid)
        }
    }

    return pids
}

func parseScreenshotPath(_ args: ArraySlice<String>) -> String? {
    let prefix = "--screenshot="
    for arg in args {
        guard arg.hasPrefix(prefix) else { continue }
        return String(arg.dropFirst(prefix.count))
    }
    return nil
}

func parseSetBounds(_ args: ArraySlice<String>) -> CGRect? {
    let prefix = "--set-bounds="
    for arg in args {
        guard arg.hasPrefix(prefix) else { continue }
        let payload = String(arg.dropFirst(prefix.count))
        let parts = payload.split(separator: ",").map {
            Double($0.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        guard parts.count == 4,
              let x = parts[0],
              let y = parts[1],
              let width = parts[2],
              let height = parts[3],
              width > 0,
              height > 0 else {
            continue
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }
    return nil
}

func parsePoints(_ args: ArraySlice<String>) -> [CGPoint]? {
    let prefix = "--points="
    for arg in args {
        guard arg.hasPrefix(prefix) else { continue }
        let payload = String(arg.dropFirst(prefix.count))
        var points: [CGPoint] = []
        for pair in payload.split(separator: ";") {
            let comps = pair.split(separator: ",")
            guard comps.count == 2,
                  let px = Double(comps[0].trimmingCharacters(in: .whitespacesAndNewlines)),
                  let py = Double(comps[1].trimmingCharacters(in: .whitespacesAndNewlines)) else {
                continue
            }
            points.append(CGPoint(x: px, y: py))
        }
        return points
    }
    return nil
}

func escapeJson(_ s: String) -> String {
    var out = ""
    for ch in s {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default: out.append(ch)
        }
    }
    return out
}

/// Topmost on-screen window containing `point`, as a JSON object string
/// (`{title,process,pid,bounds}`) or nil. Shares the same layer-0 / area /
/// exclude-pid filtering as the single-point path; used by the batch
/// `--points` mode so a single `CGWindowListCopyWindowInfo` answers many
/// points instead of one process spawn per point.
func windowJson(at point: CGPoint, in windowList: [[String: Any]], excludedPids: Set<Int>) -> String? {
    for window in windowList {
        guard let boundsDict = window[kCGWindowBounds as String] as? [String: CGFloat],
              let wx = boundsDict["X"],
              let wy = boundsDict["Y"],
              let ww = boundsDict["Width"],
              let wh = boundsDict["Height"] else { continue }

        let rect = CGRect(x: wx, y: wy, width: ww, height: wh)
        guard rect.contains(point) else { continue }
        guard ww > 0, wh > 0 else { continue }
        if let layer = window[kCGWindowLayer as String] as? Int, layer != 0 { continue }

        let title = (window[kCGWindowName as String] as? String) ?? ""
        let ownerName = (window[kCGWindowOwnerName as String] as? String) ?? ""
        let pid = (window[kCGWindowOwnerPID as String] as? Int) ?? 0
        if excludedPids.contains(pid) { continue }

        return "{\"title\":\"\(escapeJson(title))\",\"process\":\"\(escapeJson(ownerName))\",\"pid\":\(pid),\"bounds\":{\"x\":\(Int(rect.origin.x.rounded())),\"y\":\(Int(rect.origin.y.rounded())),\"width\":\(Int(rect.size.width.rounded())),\"height\":\(Int(rect.size.height.rounded()))}}"
    }
    return nil
}

func axCopy(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return result == .success ? value : nil
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    axCopy(element, attribute) as? String
}

func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    guard let value = axCopy(element, attribute) else { return nil }
    guard CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return CFBooleanGetValue((value as! CFBoolean))
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    guard let value = axCopy(element, attribute),
          CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    guard let value = axCopy(element, attribute),
          CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let point = axPoint(element, kAXPositionAttribute as String),
          let size = axSize(element, kAXSizeAttribute as String),
          size.width > 0,
          size.height > 0 else {
        return nil
    }
    return CGRect(origin: point, size: size)
}

func rectDistance(_ a: CGRect, _ b: CGRect) -> CGFloat {
    abs(a.origin.x - b.origin.x) +
        abs(a.origin.y - b.origin.y) +
        abs(a.size.width - b.size.width) +
        abs(a.size.height - b.size.height)
}

func axWindows(for pid: Int) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetMessagingTimeout(app, 1.0)
    guard let rawWindows = axCopy(app, kAXWindowsAttribute as String) else {
        return []
    }
    if let windows = rawWindows as? [AXUIElement] {
        return windows
    }
    guard CFGetTypeID(rawWindows) == CFArrayGetTypeID() else {
        return []
    }
    let array = rawWindows as! CFArray
    var windows: [AXUIElement] = []
    for index in 0..<CFArrayGetCount(array) {
        let raw = CFArrayGetValueAtIndex(array, index)
        windows.append(unsafeBitCast(raw, to: AXUIElement.self))
    }
    return windows
}

func findAXWindow(pid: Int, title: String, oldBounds: CGRect) -> AXUIElement? {
    let candidates = axWindows(for: pid).filter { element in
        axString(element, kAXRoleAttribute as String) == kAXWindowRole as String &&
            axBool(element, kAXMinimizedAttribute as String) != true
    }
    if candidates.isEmpty {
        return nil
    }

    return candidates.min { lhs, rhs in
        let lhsFrame = axFrame(lhs)
        let rhsFrame = axFrame(rhs)
        var lhsScore = lhsFrame.map { rectDistance($0, oldBounds) } ?? 100_000
        var rhsScore = rhsFrame.map { rectDistance($0, oldBounds) } ?? 100_000
        if !title.isEmpty {
            if axString(lhs, kAXTitleAttribute as String) == title { lhsScore -= 1_000 }
            if axString(rhs, kAXTitleAttribute as String) == title { rhsScore -= 1_000 }
        }
        return lhsScore < rhsScore
    }
}

func setAXWindowBounds(pid: Int, title: String, oldBounds: CGRect, newBounds: CGRect) -> (Bool, CGRect?) {
    guard let window = findAXWindow(pid: pid, title: title, oldBounds: oldBounds) else {
        return (false, nil)
    }

    var point = newBounds.origin
    var size = newBounds.size
    guard let pointValue = AXValueCreate(.cgPoint, &point),
          let sizeValue = AXValueCreate(.cgSize, &size) else {
        return (false, axFrame(window))
    }

    let positionResult = AXUIElementSetAttributeValue(
        window,
        kAXPositionAttribute as CFString,
        pointValue
    )
    let sizeResult = AXUIElementSetAttributeValue(
        window,
        kAXSizeAttribute as CFString,
        sizeValue
    )
    let moved = positionResult == .success && sizeResult == .success
    return (moved, axFrame(window))
}

// Persistent daemon: `window_info --serve` answers point/batch queries over
// stdin/stdout so the desktop avoids a process spawn (Swift + framework load,
// ~40ms each) per hover/morph probe. Read-only only — screenshots and
// --set-bounds stay one-shot (they need ScreenCaptureKit / AX side effects).
// Protocol mirrors the Windows daemon:
//   request:  <id>\t<token>\t<token>...   (tokens mirror the one-shot CLI)
//   response: <id>\t<json>\n
func serveResponse(forTokens tokens: [String]) -> String {
    let slice = tokens[...]
    let excludedPids = parseExcludedPids(slice)

    if let batchPoints = parsePoints(slice) {
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return "[]"
        }
        let items = batchPoints.map { point in
            windowJson(at: point, in: windowList, excludedPids: excludedPids) ?? "null"
        }
        return "[" + items.joined(separator: ",") + "]"
    }

    var coords: [Double] = []
    for token in tokens {
        if token.hasPrefix("--") { continue }
        if let value = Double(token) {
            coords.append(value)
            if coords.count == 2 { break }
        }
    }
    guard coords.count == 2 else { return "{\"error\":\"bad request\"}" }

    guard let windowList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        return "{\"error\":\"failed to get window list\"}"
    }
    return windowJson(
        at: CGPoint(x: coords[0], y: coords[1]),
        in: windowList,
        excludedPids: excludedPids
    ) ?? "null"
}

if CommandLine.arguments.count >= 2, CommandLine.arguments[1] == "--serve" {
    // stdout is block-buffered when piped; make it unbuffered so each response
    // reaches the desktop client immediately instead of timing out.
    setvbuf(stdout, nil, _IONBF, 0)
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        guard let tabIndex = line.firstIndex(of: "\t") else { continue }
        let id = String(line[line.startIndex..<tabIndex])
        let rest = String(line[line.index(after: tabIndex)...])
        let tokens = rest
            .split(separator: "\t", omittingEmptySubsequences: false)
            .map(String.init)
        print("\(id)\t\(serveResponse(forTokens: tokens))")
    }
    exit(0)
}

// Batch mode: `window_info --points=x1,y1;x2,y2;...` answers many points from
// a single window-list copy and prints a JSON array (one entry per point, in
// order; null when no window is found). Used by the morph-visibility gate so a
// transition probes N sample points with one process spawn instead of N.
if let batchPoints = parsePoints(CommandLine.arguments.dropFirst()) {
    let excludedPids = parseExcludedPids(CommandLine.arguments.dropFirst())
    guard let windowList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        print("[]")
        exit(0)
    }
    let items = batchPoints.map { point in
        windowJson(at: point, in: windowList, excludedPids: excludedPids) ?? "null"
    }
    print("[" + items.joined(separator: ",") + "]")
    exit(0)
}

guard CommandLine.arguments.count >= 3,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]) else {
    fputs("Usage: window_info <x> <y>\n", stderr)
    exit(1)
}

let point = CGPoint(x: x, y: y)
let extraArgs = CommandLine.arguments.dropFirst(3)
let excludedPids = parseExcludedPids(extraArgs)
let screenshotPath = parseScreenshotPath(extraArgs)
let setBounds = parseSetBounds(extraArgs)

// Get all on-screen windows (excluding desktop elements)
guard let windowList = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] else {
    print("{\"error\":\"failed to get window list\"}")
    exit(0)
}

// Find the topmost window whose bounds contain the point
for window in windowList {
    guard let boundsDict = window[kCGWindowBounds as String] as? [String: CGFloat],
          let wx = boundsDict["X"],
          let wy = boundsDict["Y"],
          let ww = boundsDict["Width"],
          let wh = boundsDict["Height"] else { continue }

    let rect = CGRect(x: wx, y: wy, width: ww, height: wh)
    guard rect.contains(point) else { continue }

    // Skip windows with zero area or non-zero layer (Dock=20, MenuBar=24, StatusItems=25, etc.)
    guard ww > 0, wh > 0 else { continue }
    if let layer = window[kCGWindowLayer as String] as? Int, layer != 0 { continue }

    let title = (window[kCGWindowName as String] as? String) ?? ""
    let ownerName = (window[kCGWindowOwnerName as String] as? String) ?? ""
    let pid = (window[kCGWindowOwnerPID as String] as? Int) ?? 0
    if excludedPids.contains(pid) { continue }

    let windowID = (window[kCGWindowNumber as String] as? CGWindowID) ?? 0
    var outputBounds = rect
    var moved = false

    if let targetBounds = setBounds {
        let result = setAXWindowBounds(
            pid: pid,
            title: title,
            oldBounds: rect,
            newBounds: targetBounds
        )
        moved = result.0
        if let finalBounds = result.1 {
            outputBounds = finalBounds
        }
    }

    let json = """
    {"title":"\(escapeJson(title))","process":"\(escapeJson(ownerName))","pid":\(pid),"bounds":{"x":\(Int(outputBounds.origin.x.rounded())),"y":\(Int(outputBounds.origin.y.rounded())),"width":\(Int(outputBounds.size.width.rounded())),"height":\(Int(outputBounds.size.height.rounded()))},"moved":\(moved ? "true" : "false")}
    """
    print(json.trimmingCharacters(in: .whitespacesAndNewlines))

    // Capture screenshot if requested (ScreenCaptureKit replaces deprecated CGWindowListCreateImage)
    if let ssPath = screenshotPath, windowID != 0 {
        let captureWidth = Int(ww)
        let captureHeight = Int(wh)
        let semaphore = DispatchSemaphore(value: 0)
        Task.detached {
            defer { semaphore.signal() }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: true
                )
                guard let scWindow = content.windows.first(where: { $0.windowID == windowID })
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
}

print("{\"error\":\"no window at point\"}")
