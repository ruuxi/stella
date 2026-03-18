// window_text - Extract visible text from a window using Accessibility API
// Usage: window_text <pid> <x> <y>
// Output: Raw text to stdout (UTF-8), empty on failure
//
// Strategy:
// 1. Walk the accessibility tree collecting elements with position/size/text
// 2. Column-aware filter: find the content column under the cursor,
//    extract text from that column only (avoids sidebars, navbars, etc.)
// 3. Fallback: all elements with role filtering
//
// Build: swiftc -O -o window_text src/window_text.swift -framework ApplicationServices -framework Foundation

import ApplicationServices
import Foundation

let MAX_ELEMENTS = 2000
let MIN_USEFUL_TEXT = 50
let COLUMN_PAD: CGFloat = 60
let MIN_COLUMN_WIDTH: CGFloat = 300
let MAX_TEXT_OUTPUT = 32000
let MIN_ANCHOR_AREA: CGFloat = 5000
let MAX_DEPTH = 10

let skipRoles: Set<String> = [
    "AXMenuBar", "AXMenu", "AXMenuItem", "AXMenuButton",
    "AXToolbar", "AXScrollBar", "AXSplitter", "AXGrowArea",
    "AXBusyIndicator"
]

struct ElementInfo {
    let rect: CGRect
    let name: String?
    let value: String?
}

func getAttribute<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard result == .success else { return nil }
    return value as? T
}

func getPosition(_ element: AXUIElement) -> CGPoint? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as String as CFString, &value) == .success,
          let axValue = value else { return nil }
    var point = CGPoint.zero
    AXValueGetValue(axValue as! AXValue, .cgPoint, &point)
    return point
}

func getSize(_ element: AXUIElement) -> CGSize? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXSizeAttribute as String as CFString, &value) == .success,
          let axValue = value else { return nil }
    var size = CGSize.zero
    AXValueGetValue(axValue as! AXValue, .cgSize, &size)
    return size
}

func walkTree(_ element: AXUIElement, _ elements: inout [ElementInfo], depth: Int = 0) {
    guard depth < MAX_DEPTH, elements.count < MAX_ELEMENTS else { return }

    // Check role
    if let role: String = getAttribute(element, kAXRoleAttribute as String) {
        if skipRoles.contains(role) { return }
    }

    // Get position and size
    if let pos = getPosition(element), let size = getSize(element) {
        let rect = CGRect(x: pos.x, y: pos.y, width: size.width, height: size.height)

        // Get text content
        let value: String? = getAttribute(element, kAXValueAttribute as String)
        let name: String? = getAttribute(element, kAXTitleAttribute as String)
            ?? getAttribute(element, kAXDescriptionAttribute as String)

        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedValue = value?.trimmingCharacters(in: .whitespacesAndNewlines)

        let hasName = trimmedName != nil && !trimmedName!.isEmpty
        let hasValue = trimmedValue != nil && !trimmedValue!.isEmpty

        elements.append(ElementInfo(
            rect: rect,
            name: hasName ? trimmedName : nil,
            value: hasValue ? trimmedValue : nil
        ))
    }

    // Walk children
    guard let children: [AXUIElement] = getAttribute(element, kAXChildrenAttribute as String) else { return }
    for child in children.prefix(200) {
        guard elements.count < MAX_ELEMENTS else { break }
        walkTree(child, &elements, depth: depth + 1)
    }
}

// --- Main ---

guard CommandLine.arguments.count >= 4,
      let pid = Int32(CommandLine.arguments[1]),
      let cursorX = Double(CommandLine.arguments[2]),
      let cursorY = Double(CommandLine.arguments[3]) else {
    exit(1)
}

let app = AXUIElementCreateApplication(pid)

// Get windows
guard let windows: [AXUIElement] = getAttribute(app, kAXWindowsAttribute as String),
      !windows.isEmpty else {
    exit(0)
}

let window = windows[0]

// Try to get value directly from window (some editors expose full text)
if let windowValue: String = getAttribute(window, kAXValueAttribute as String) {
    let trimmed = windowValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.count >= MIN_USEFUL_TEXT {
        let output = trimmed.count > MAX_TEXT_OUTPUT ? String(trimmed.prefix(MAX_TEXT_OUTPUT)) : trimmed
        print(output, terminator: "")
        exit(0)
    }
}

// Walk the tree
var elements: [ElementInfo] = []
elements.reserveCapacity(1000)
walkTree(window, &elements)

if elements.isEmpty { exit(0) }

// --- Column-Aware Filtering ---

let cx = CGFloat(cursorX)
let cy = CGFloat(cursorY)

// Find anchor: smallest area element containing cursor
var anchorIdx = -1
var minArea: CGFloat = .greatestFiniteMagnitude
var smallAnchorIdx = -1
var smallMinArea: CGFloat = .greatestFiniteMagnitude

for i in 0..<elements.count {
    let el = elements[i]
    if el.rect.contains(CGPoint(x: cx, y: cy)) {
        let area = el.rect.width * el.rect.height
        if area > 0 {
            if area < smallMinArea {
                smallMinArea = area
                smallAnchorIdx = i
            }
            if area >= MIN_ANCHOR_AREA && area < minArea {
                minArea = area
                anchorIdx = i
            }
        }
    }
}

if anchorIdx < 0 { anchorIdx = smallAnchorIdx }

// If nothing contains cursor, find nearest
if anchorIdx < 0 {
    var minDist: CGFloat = .greatestFiniteMagnitude
    for i in 0..<elements.count {
        let el = elements[i]
        let elCX = el.rect.midX
        let elCY = el.rect.midY
        let dist = (elCX - cx) * (elCX - cx) + (elCY - cy) * (elCY - cy)
        if dist < minDist {
            minDist = dist
            anchorIdx = i
        }
    }
}

// Define column band
var colLeft: CGFloat = -10000
var colRight: CGFloat = 10000

if anchorIdx >= 0 {
    let anchor = elements[anchorIdx]
    colLeft = anchor.rect.minX - COLUMN_PAD
    colRight = anchor.rect.maxX + COLUMN_PAD
    let colWidth = colRight - colLeft
    if colWidth < MIN_COLUMN_WIDTH {
        let center = (colLeft + colRight) / 2
        colLeft = center - MIN_COLUMN_WIDTH / 2
        colRight = center + MIN_COLUMN_WIDTH / 2
    }
}

func collectText(useColumnFilter: Bool) -> String {
    var seen = Set<String>()
    var parts: [String] = []
    var count = 0

    for el in elements {
        if count >= 500 { break }

        if useColumnFilter {
            if el.rect.maxX < colLeft + 20 || el.rect.minX > colRight - 20 {
                continue
            }
        }

        if let name = el.name, !seen.contains(name) {
            seen.insert(name)
            parts.append(name)
            count += 1
        }
        if let value = el.value, !seen.contains(value) {
            seen.insert(value)
            parts.append(value)
            count += 1
        }
    }

    return parts.joined(separator: "\n")
}

// Pass 1: column-filtered
var text = collectText(useColumnFilter: true)

// Pass 2: fallback
if text.count < MIN_USEFUL_TEXT {
    text = collectText(useColumnFilter: false)
}

let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
if !trimmed.isEmpty {
    let output = trimmed.count > MAX_TEXT_OUTPUT ? String(trimmed.prefix(MAX_TEXT_OUTPUT)) : trimmed
    print(output, terminator: "")
}
