// home_apps - List running user-facing apps for the Stella home suggestion
// chip strip. Returns each app with its topmost on-screen window title in
// most-recent-used order.
//
// Usage:
//   home_apps list
//
// Output (JSON to stdout):
//   {
//     "ok": true,
//     "apps": [
//       {
//         "name": "Cursor",
//         "bundleId": "com.todesktop...",
//         "pid": 42308,
//         "isActive": true,
//         "windowTitle": "use-auto-context-chips.ts — desktop"
//       },
//       …
//     ],
//     "warnings": ["titles: cg=2 ax=4 needsAx=5 axTrusted=true"]
//   }
//
// Why this is its own binary instead of a desktop_automation subcommand:
// the home chip strip is a renderer-side affordance that wants particular
// behavior (MRU sort, AX title fallback, regular-apps-only AX scope, per
// element messaging timeouts, diagnostics in warnings). Those choices
// don't belong in the agent-facing `desktop_automation list-apps` tool,
// which is contractually a stable list of every running app in a sensible
// default order.
//
// Build: swiftc -O -o out/darwin/home_apps src/home_apps.swift \
//   -framework AppKit -framework ApplicationServices \
//   -framework CoreGraphics -framework Foundation

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

struct ListedAppPayload: Codable {
    let name: String
    let bundleId: String?
    let pid: Int32
    let isActive: Bool
    let windowTitle: String
    /// Base64-encoded PNG data URL of the app's Dock icon, downsized to 32×32.
    /// `nil` when the app exposes no icon (rare) or encoding failed. The
    /// renderer falls back to the app name when missing.
    let iconDataUrl: String?
}

struct ListAppsPayload: Codable {
    let ok: Bool
    let apps: [ListedAppPayload]
    let warnings: [String]
}

func emitJson<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(value),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"ok\":false,\"apps\":[],\"warnings\":[\"encode failed\"]}")
    }
}

// ---------------------------------------------------------------------------
// App icon → base64 PNG data URL
//
// `NSRunningApplication.icon` returns a multi-representation NSImage; we
// downsize to 32×32 and PNG-encode so the renderer can paint a crisp 16px
// chip on retina without paying for a full-size icon (~256×256, 30+ KB).
// Encoded payload is ~1–3 KB per app, base64 included.
//
// We deliberately avoid `NSImage.lockFocus()` / `tiffRepresentation` here:
// they need a live NSApplication run loop and noisily fail with
// `CGImageDestinationFinalize failed` when run from a CLI helper. The
// CGContext path below is fully Core Graphics and works headless.
// ---------------------------------------------------------------------------

func encodeAppIconAsBase64(_ icon: NSImage?) -> String? {
    guard let icon, icon.size.width > 0, icon.size.height > 0 else { return nil }

    let targetSize = CGSize(width: 32, height: 32)
    var proposedRect = NSRect(origin: .zero, size: targetSize)
    guard let sourceCGImage = icon.cgImage(
        forProposedRect: &proposedRect,
        context: nil,
        hints: nil
    ) else {
        return nil
    }

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
    guard let context = CGContext(
        data: nil,
        width: Int(targetSize.width),
        height: Int(targetSize.height),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: bitmapInfo.rawValue
    ) else {
        return nil
    }
    context.interpolationQuality = .high
    context.draw(sourceCGImage, in: CGRect(origin: .zero, size: targetSize))

    guard let resizedCGImage = context.makeImage() else { return nil }

    let bitmap = NSBitmapImageRep(cgImage: resizedCGImage)
    guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
        return nil
    }
    let base64 = pngData.base64EncodedString()
    return "data:image/png;base64,\(base64)"
}

// ---------------------------------------------------------------------------
// AX helpers (minimal — we only need title reads)
// ---------------------------------------------------------------------------

/// Read an attribute value as `AnyObject` (or nil if absent / error).
func axAttributeValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: AnyObject?
    let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard status == .success else { return nil }
    return value
}

/// Read a string attribute, trimmed; nil if absent or empty after trim.
func axStringValue(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let raw = axAttributeValue(element, attribute) else { return nil }
    if let s = raw as? String {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    return nil
}

/// Read an attribute that returns an AXUIElement (focused window, etc.).
func axElementValue(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let raw = axAttributeValue(element, attribute) else { return nil }
    return unsafeBitCast(raw, to: AXUIElement.self)
}

/// Read an attribute that returns an array of AXUIElements (windows, etc.).
func axElementArrayValue(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
    guard let raw = axAttributeValue(element, attribute) else { return [] }
    guard CFGetTypeID(raw) == CFArrayGetTypeID() else { return [] }
    let array = unsafeBitCast(raw, to: CFArray.self)
    let count = CFArrayGetCount(array)
    var results: [AXUIElement] = []
    results.reserveCapacity(count)
    for index in 0..<count {
        let pointer = CFArrayGetValueAtIndex(array, index)
        results.append(unsafeBitCast(pointer, to: AXUIElement.self))
    }
    return results
}

// ---------------------------------------------------------------------------
// Title collection: CG path + AX fallback
// ---------------------------------------------------------------------------

struct TitleCollectionResult {
    let titles: [Int32: String]
    let cgFilledCount: Int
    let needsAxCount: Int
    let axTrusted: Bool
    let axFilledCount: Int
}

/// Build a pid → topmost-window-title map for the given pids.
///
/// Two-stage:
///   1. CG path — `CGWindowListCopyWindowInfo` is fastest when it works,
///      but `kCGWindowName` is silently empty for any background app
///      under modern macOS Screen Recording privacy gates. That's most
///      apps in practice, hence the fallback.
///   2. AX path — `AXUIElementCreateApplication(pid)` + `AXTitle` works
///      for every app the user has granted Stella's bundle Accessibility
///      permission for. We constrain to caller-supplied pids (the regular
///      apps the chip strip will actually display) so the loop stays
///      bounded.
func collectTopWindowTitlesByPid(targetPids: Set<Int32>) -> TitleCollectionResult {
    var titles: [Int32: String] = [:]

    if let windowList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] {
        for window in windowList {
            guard let pid32 = (window[kCGWindowOwnerPID as String] as? Int).map(Int32.init) else {
                continue
            }
            if !targetPids.contains(pid32) { continue }
            if titles[pid32] != nil { continue }
            // Layer 0 is normal-priority window content; >0 is chrome.
            if let layer = window[kCGWindowLayer as String] as? Int, layer > 0 { continue }
            let rawTitle = (window[kCGWindowName as String] as? String) ?? ""
            let trimmed = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            titles[pid32] = trimmed
        }
    }

    let cgFilledCount = titles.count

    // AX fallback for every target pid CG didn't fill. Per-element
    // messaging timeouts cap the worst case at ~0.5s per pid (focused
    // window query + first-window query) so a single beachballed app
    // can't stall the whole snapshot past the renderer's IPC deadline.
    let needsAxLookup = targetPids.subtracting(titles.keys)
    let axTrusted = AXIsProcessTrusted()
    var axFilledCount = 0
    if !needsAxLookup.isEmpty, axTrusted {
        for pid in needsAxLookup {
            let axApp = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(axApp, 0.25)
            let candidate =
                axElementValue(axApp, kAXFocusedWindowAttribute as String)
                ?? axElementArrayValue(axApp, kAXWindowsAttribute as String).first
            guard let candidate else { continue }
            AXUIElementSetMessagingTimeout(candidate, 0.25)
            if let title = axStringValue(candidate, kAXTitleAttribute as String),
               !title.isEmpty {
                titles[pid] = title
                axFilledCount += 1
            }
        }
    }

    return TitleCollectionResult(
        titles: titles,
        cgFilledCount: cgFilledCount,
        needsAxCount: needsAxLookup.count,
        axTrusted: axTrusted,
        axFilledCount: axFilledCount
    )
}

// ---------------------------------------------------------------------------
// MRU rank: front-to-back z-order of on-screen layer-0 windows
// ---------------------------------------------------------------------------

func mruRankByPid() -> [Int32: Int] {
    var rank: [Int32: Int] = [:]
    var nextRank = 0
    guard let windowList = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        return rank
    }
    for window in windowList {
        guard let pid32 = (window[kCGWindowOwnerPID as String] as? Int).map(Int32.init) else {
            continue
        }
        if let layer = window[kCGWindowLayer as String] as? Int, layer != 0 { continue }
        if rank[pid32] != nil { continue }
        rank[pid32] = nextRank
        nextRank += 1
    }
    return rank
}

// ---------------------------------------------------------------------------
// Activation-policy ranking — used to tiebreak unranked apps deterministically.
// ---------------------------------------------------------------------------

func activationPolicyRank(_ policy: NSApplication.ActivationPolicy) -> Int {
    switch policy {
    case .regular:
        return 0
    case .accessory:
        return 1
    case .prohibited:
        return 2
    @unknown default:
        return 3
    }
}

func normalized(_ s: String?) -> String {
    return (s ?? "").lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

func runListCommand() {
    let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let runningApps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy != .prohibited && $0.processIdentifier > 0 }

    // Only ask AX for titles of regular apps — the only ones the renderer
    // ever shows as suggestion chips. Skipping accessory/agent apps
    // (menubar widgets, login items, helpers) bounds the AX loop so the
    // helper doesn't get killed for taking too long.
    let targetPids = Set(
        runningApps
            .filter { $0.activationPolicy == .regular }
            .map { $0.processIdentifier }
    )
    let collected = collectTopWindowTitlesByPid(targetPids: targetPids)
    let titlesByPid = collected.titles
    let mruRank = mruRankByPid()
    let unrankedSentinel = Int.max

    let sorted = runningApps
        .sorted { lhs, rhs in
            // Strict MRU: front-to-back window stack order. Frontmost is
            // marked separately via `isActive` but doesn't get pinned to
            // slot 0 — pure recency wins so the strip stays stable when
            // focus moves around.
            let lhsRank = mruRank[lhs.processIdentifier] ?? unrankedSentinel
            let rhsRank = mruRank[rhs.processIdentifier] ?? unrankedSentinel
            if lhsRank != rhsRank { return lhsRank < rhsRank }

            let lhsPolicyRank = activationPolicyRank(lhs.activationPolicy)
            let rhsPolicyRank = activationPolicyRank(rhs.activationPolicy)
            if lhsPolicyRank != rhsPolicyRank {
                return lhsPolicyRank < rhsPolicyRank
            }

            let lhsName = normalized(lhs.localizedName ?? lhs.bundleIdentifier)
            let rhsName = normalized(rhs.localizedName ?? rhs.bundleIdentifier)
            if lhsName != rhsName {
                return lhsName < rhsName
            }
            return lhs.processIdentifier < rhs.processIdentifier
        }

    // The renderer only ever surfaces the top handful of apps as chips,
    // but we emit the full sorted list so the JS-side noise filters can
    // run before slicing. Icon encoding (~5ms per app) is by far the
    // hottest cost in this binary, so cap it to the first N entries the
    // renderer could plausibly show.
    let iconBudget = 12
    let apps = sorted.enumerated().map { (index, app) -> ListedAppPayload in
        let iconDataUrl = index < iconBudget ? encodeAppIconAsBase64(app.icon) : nil
        return ListedAppPayload(
            name: app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)",
            bundleId: app.bundleIdentifier,
            pid: app.processIdentifier,
            isActive: app.processIdentifier == frontmostPid,
            windowTitle: titlesByPid[app.processIdentifier] ?? "",
            iconDataUrl: iconDataUrl
        )
    }

    let diagnostics = [
        "titles: cg=\(collected.cgFilledCount) ax=\(collected.axFilledCount) needsAx=\(collected.needsAxCount) axTrusted=\(collected.axTrusted)",
    ]
    emitJson(ListAppsPayload(ok: true, apps: apps, warnings: diagnostics))
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "list"

switch command {
case "list":
    runListCommand()
default:
    fputs("Usage: home_apps list\n", stderr)
    exit(1)
}
