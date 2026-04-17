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
//   {"title":"…","process":"App","pid":123,"bounds":{"x":0,"y":0,"width":W,"height":H}}
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
//   -framework ScreenCaptureKit

import AppKit
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

struct WindowMatch {
    let windowID: CGWindowID
    let title: String
    let ownerName: String
    let bounds: (x: Double, y: Double, w: Double, h: Double)
}

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

    // Front-to-back order; first match wins.
    for window in windowList {
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

        return WindowMatch(
            windowID: windowID,
            title: title,
            ownerName: ownerName,
            bounds: (Double(wx), Double(wy), Double(ww), Double(wh))
        )
    }

    return nil
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

let json = """
{"title":"\(escapeJson(match.title))","process":"\(escapeJson(match.ownerName))","pid":\(pid),"bounds":{"x":\(bx),"y":\(by),"width":\(bw),"height":\(bh)}}
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
