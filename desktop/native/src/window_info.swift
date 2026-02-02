// window_info - Returns JSON info about the window at a given screen point
// Usage: window_info <x> <y>
// Build: swiftc -O -o window_info src/window_info.swift -framework CoreGraphics -framework AppKit
// Output: {"title":"...","process":"...","pid":123,"bounds":{"x":0,"y":0,"width":800,"height":600}}

import AppKit
import CoreGraphics
import Foundation

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

    let json = """
    {"title":"\(escapeJson(title))","process":"\(escapeJson(ownerName))","pid":\(pid),"bounds":{"x":\(Int(wx)),"y":\(Int(wy)),"width":\(Int(ww)),"height":\(Int(wh))}}
    """
    print(json.trimmingCharacters(in: .whitespacesAndNewlines))
    exit(0)
}

print("{\"error\":\"no window at point\"}")
