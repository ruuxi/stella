// window_info - Returns JSON info about the window at a given screen point
// Usage: window_info <x> <y> [--exclude-pids=1,2,3] [--screenshot=path.png]
// Build: swiftc -O -o window_info src/window_info.swift -framework CoreGraphics -framework AppKit
// Output: {"title":"...","process":"...","pid":123,"bounds":{"x":0,"y":0,"width":800,"height":600}}

import AppKit
import CoreGraphics
import Foundation

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

    // Skip windows with zero area or layer < 0 (system elements)
    guard ww > 0, wh > 0 else { continue }
    if let layer = window[kCGWindowLayer as String] as? Int, layer < 0 { continue }

    let title = (window[kCGWindowName as String] as? String) ?? ""
    let ownerName = (window[kCGWindowOwnerName as String] as? String) ?? ""
    let pid = (window[kCGWindowOwnerPID as String] as? Int) ?? 0
    if excludedPids.contains(pid) { continue }

    let windowID = (window[kCGWindowNumber as String] as? CGWindowID) ?? 0

    let json = """
    {"title":"\(escapeJson(title))","process":"\(escapeJson(ownerName))","pid":\(pid),"bounds":{"x":\(Int(wx)),"y":\(Int(wy)),"width":\(Int(ww)),"height":\(Int(wh))}}
    """
    print(json.trimmingCharacters(in: .whitespacesAndNewlines))

    // Capture screenshot if requested
    if let ssPath = screenshotPath, windowID != 0 {
        if let cgImage = CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            windowID,
            [.boundsIgnoreFraming]
        ) {
            let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
            if let pngData = bitmapRep.representation(using: .png, properties: [:]) {
                let url = URL(fileURLWithPath: ssPath)
                try? pngData.write(to: url)
            }
        }
    }

    exit(0)
}

print("{\"error\":\"no window at point\"}")
