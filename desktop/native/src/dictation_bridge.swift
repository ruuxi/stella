// dictation_bridge - Native macOS helpers for dictation paste/routing.
//
// Usage:
//   dictation_bridge probe
//   dictation_bridge paste <text>
//   dictation_bridge mute-output
//   dictation_bridge restore-output <previousVolume>
//
// probe output:
//   {"ok":true,"frontmostBundleId":"com.apple.Safari","frontmostPid":123,"focusedEditable":true}
//
// Build:
//   swiftc -O -o out/darwin/dictation_bridge src/dictation_bridge.swift \
//     -framework AppKit -framework ApplicationServices -framework Carbon -framework CoreAudio -framework AudioToolbox

import AppKit
import ApplicationServices
import AudioToolbox
import Carbon.HIToolbox
import CoreAudio
import Foundation

func jsonEscape(_ value: String) -> String {
    let data = try? JSONSerialization.data(
        withJSONObject: [value],
        options: [.fragmentsAllowed]
    )
    guard let data = data, let raw = String(data: data, encoding: .utf8) else {
        return "\"\""
    }
    return raw
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
}

func emitProbe(ok: Bool, bundleId: String?, pid: pid_t?, focusedEditable: Bool, error: String? = nil) {
    var parts: [String] = ["\"ok\":\(ok ? "true" : "false")"]
    if let bundleId {
        parts.append("\"frontmostBundleId\":\(jsonEscape(bundleId))")
    }
    if let pid {
        parts.append("\"frontmostPid\":\(pid)")
    }
    parts.append("\"focusedEditable\":\(focusedEditable ? "true" : "false")")
    if let error {
        parts.append("\"error\":\(jsonEscape(error))")
    }
    print("{\(parts.joined(separator: ","))}", terminator: "")
}

func emitJson(_ values: [String: Any]) {
    let data = try? JSONSerialization.data(withJSONObject: values, options: [])
    guard let data, let json = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"error\":\"Failed to encode JSON\"}", terminator: "")
        return
    }
    print(json, terminator: "")
}

func axCopy(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return result == .success ? value : nil
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let value = axCopy(element, attribute) else { return nil }
    return value as? String
}

func axSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable = DarwinBoolean(false)
    let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
    return result == .success && settable.boolValue
}

func focusedElement() -> AXUIElement? {
    let systemWide = AXUIElementCreateSystemWide()
    if let focused = axCopy(systemWide, kAXFocusedUIElementAttribute) {
        return unsafeBitCast(focused, to: AXUIElement.self)
    }
    guard let frontmost = NSWorkspace.shared.frontmostApplication else { return nil }
    let app = AXUIElementCreateApplication(frontmost.processIdentifier)
    if let focused = axCopy(app, kAXFocusedUIElementAttribute) {
        return unsafeBitCast(focused, to: AXUIElement.self)
    }
    return nil
}

let editableRoles: Set<String> = [
    "AXTextArea",
    "AXTextField",
    "AXComboBox",
    "AXSearchField",
]

let editableSubroles: Set<String> = [
    "AXSecureTextField",
    "AXContentEditable",
]

// Presence of any of these implies a caret-bearing text element, even when
// the element exposes a generic role like AXGroup / AXStaticText (common in
// contentEditable hosts, ProseMirror, CodeMirror, Slack/Notion compose).
let caretAttributes: [String] = [
    kAXSelectedTextRangeAttribute as String,
    kAXNumberOfCharactersAttribute as String,
    kAXInsertionPointLineNumberAttribute as String,
    kAXVisibleCharacterRangeAttribute as String,
]

func elementLooksEditable(_ element: AXUIElement) -> Bool {
    let role = axString(element, kAXRoleAttribute)
    let subrole = axString(element, kAXSubroleAttribute)
    if let role, editableRoles.contains(role) { return true }
    if let subrole, editableSubroles.contains(subrole) { return true }
    if axSettable(element, kAXValueAttribute as String) { return true }
    if axSettable(element, kAXSelectedTextAttribute as String) { return true }
    for attr in caretAttributes {
        if axCopy(element, attr) != nil { return true }
    }
    return false
}

func focusedElementIsEditable() -> Bool {
    guard let initial = focusedElement() else { return false }
    var current: AXUIElement = initial
    for _ in 0..<5 {
        if elementLooksEditable(current) { return true }
        guard let parent = axCopy(current, kAXParentAttribute) else { return false }
        current = unsafeBitCast(parent, to: AXUIElement.self)
    }
    return false
}

struct PasteboardSnapshot {
    let items: [[String: Data]]

    init(_ pasteboard: NSPasteboard) {
        var next: [[String: Data]] = []
        for item in pasteboard.pasteboardItems ?? [] {
            var entry: [String: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) {
                    entry[type.rawValue] = data
                }
            }
            next.append(entry)
        }
        items = next
    }

    func restore(to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        for entry in items {
            let item = NSPasteboardItem()
            for (rawType, data) in entry {
                item.setData(data, forType: NSPasteboard.PasteboardType(rawValue: rawType))
            }
            pasteboard.writeObjects([item])
        }
    }
}

func writeTextToPasteboard(_ text: String) -> Int {
    let pasteboard = NSPasteboard.general
    let before = pasteboard.changeCount
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    let after = pasteboard.changeCount
    return after == before ? after + 1 : after
}

func waitForPasteboardCommit(targetChangeCount: Int, timeoutMs: Int = 150) {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    while Date() < deadline {
        if NSPasteboard.general.changeCount >= targetChangeCount {
            return
        }
        usleep(5_000)
    }
}

func postCmdV() -> Bool {
    guard let source = CGEventSource(stateID: .combinedSessionState) else { return false }
    let commandKey: CGKeyCode = 55
    let vKey: CGKeyCode = 9
    guard
        let cmdDown = CGEvent(keyboardEventSource: source, virtualKey: commandKey, keyDown: true),
        let vDown = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true),
        let vUp = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false),
        let cmdUp = CGEvent(keyboardEventSource: source, virtualKey: commandKey, keyDown: false)
    else {
        return false
    }
    vDown.flags = .maskCommand
    vUp.flags = .maskCommand
    cmdDown.post(tap: .cghidEventTap)
    vDown.post(tap: .cghidEventTap)
    vUp.post(tap: .cghidEventTap)
    cmdUp.post(tap: .cghidEventTap)
    return true
}

enum PasteError: Error {
    case focusedElementNotFound
    case failedToInsertText
}

func insertTextAtCursor(_ text: String) throws {
    guard let focused = focusedElement() else {
        throw PasteError.focusedElementNotFound
    }
    let result = AXUIElementSetAttributeValue(
        focused,
        kAXSelectedTextAttribute as CFString,
        text as CFTypeRef
    )
    if result != .success {
        throw PasteError.failedToInsertText
    }
}

func paste(_ text: String) {
    let pasteboard = NSPasteboard.general
    let snapshot = PasteboardSnapshot(pasteboard)
    let targetChangeCount = writeTextToPasteboard(text)
    waitForPasteboardCommit(targetChangeCount: targetChangeCount)
    let pasted = postCmdV()
    if !pasted {
        try? insertTextAtCursor(text)
    }
    usleep(500_000)
    snapshot.restore(to: pasteboard)
    print("{\"ok\":true,\"strategy\":\(pasted ? "\"cmd-v\"" : "\"accessibility\"")}", terminator: "")
}

func audioPropertyAddress(
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: scope,
        mElement: element
    )
}

func getDefaultOutputDevice() -> AudioDeviceID? {
    var address = audioPropertyAddress(kAudioHardwarePropertyDefaultOutputDevice)
    var deviceId = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &size,
        &deviceId
    )
    return status == noErr && deviceId != 0 ? deviceId : nil
}

func getSystemOutputVolume() -> Float? {
    guard let deviceId = getDefaultOutputDevice() else { return nil }
    var address = audioPropertyAddress(
        kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        scope: kAudioDevicePropertyScopeOutput
    )
    var volume = Float32(0)
    var size = UInt32(MemoryLayout<Float32>.size)
    let status = AudioObjectGetPropertyData(deviceId, &address, 0, nil, &size, &volume)
    return status == noErr ? volume : nil
}

func setSystemOutputVolume(_ volume: Float) -> Bool {
    guard let deviceId = getDefaultOutputDevice() else { return false }
    var address = audioPropertyAddress(
        kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        scope: kAudioDevicePropertyScopeOutput
    )
    var nextVolume = min(max(Float32(volume), 0), 1)
    let size = UInt32(MemoryLayout<Float32>.size)
    let status = AudioObjectSetPropertyData(deviceId, &address, 0, nil, size, &nextVolume)
    return status == noErr
}

func muteOutput() {
    guard let previousVolume = getSystemOutputVolume() else {
        emitJson(["ok": false, "error": "Unable to read output volume"])
        exit(1)
    }
    guard setSystemOutputVolume(0) else {
        emitJson(["ok": false, "error": "Unable to mute output volume"])
        exit(1)
    }
    emitJson(["ok": true, "previousVolume": previousVolume])
}

func restoreOutput(_ rawVolume: String?) {
    guard let rawVolume, let volume = Float(rawVolume) else {
        emitJson(["ok": false, "error": "Missing previous volume"])
        exit(2)
    }
    guard setSystemOutputVolume(volume) else {
        emitJson(["ok": false, "error": "Unable to restore output volume"])
        exit(1)
    }
    emitJson(["ok": true])
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    emitProbe(ok: false, bundleId: nil, pid: nil, focusedEditable: false, error: "Missing command")
    exit(2)
}

switch command {
case "probe":
    let app = NSWorkspace.shared.frontmostApplication
    emitProbe(
        ok: true,
        bundleId: app?.bundleIdentifier,
        pid: app?.processIdentifier,
        focusedEditable: focusedElementIsEditable()
    )
case "paste":
    let text = args.dropFirst().joined(separator: " ")
    paste(text)
case "mute-output":
    muteOutput()
case "restore-output":
    restoreOutput(args.dropFirst().first)
default:
    emitProbe(ok: false, bundleId: nil, pid: nil, focusedEditable: false, error: "Unknown command")
    exit(2)
}
