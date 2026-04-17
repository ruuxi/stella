// mouse_block — standalone helper that blocks Cmd+RightClick on macOS.
//
// Installs a CGEventTap on the session-level event stream and intercepts
// `rightMouseDown` / `rightMouseUp` (and the trackpad two-finger equivalent
// `otherMouseDown` / `otherMouseUp`) when Command is held at the moment of
// press. Blocked events emit `DOWN <x> <y>` and `UP <x> <y>` lines on stdout
// so the parent process can drive the Stella quick-menu without the OS
// context menu appearing.
//
// Build: swiftc -O -o out/darwin/mouse_block src/mouse_block.swift \
//   -framework CoreGraphics -framework AppKit -framework Foundation

import AppKit
import CoreGraphics
import Foundation

// Disable stdout buffering so the parent process sees DOWN/UP immediately.
setvbuf(stdout, nil, _IONBF, 0)

final class State {
    var blockingActive = false
}

let state = State()
let stateRef = Unmanaged.passUnretained(state).toOpaque()

let eventMask: CGEventMask =
    (1 << CGEventType.rightMouseDown.rawValue) |
    (1 << CGEventType.rightMouseUp.rawValue)

let callback: CGEventTapCallBack = { (_, type, event, refcon) in
    guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
    let state = Unmanaged<State>.fromOpaque(refcon).takeUnretainedValue()

    // The OS may disable the tap if it stalls. Re-enable and pass the event
    // through so we don't drop user input.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        return Unmanaged.passUnretained(event)
    }

    if type == .rightMouseDown {
        let cmdHeld = event.flags.contains(.maskCommand)
        if cmdHeld {
            state.blockingActive = true
            let loc = event.location
            let line = "DOWN \(Int(loc.x)) \(Int(loc.y))\n"
            if let data = line.data(using: .utf8) {
                FileHandle.standardOutput.write(data)
            }
            return nil // drop the event
        }
        return Unmanaged.passUnretained(event)
    }

    if type == .rightMouseUp {
        // If we ate the matching down, eat the up too — even if the user
        // released Command between down and up — so the foreground app never
        // sees half a click.
        if state.blockingActive {
            state.blockingActive = false
            let loc = event.location
            let line = "UP \(Int(loc.x)) \(Int(loc.y))\n"
            if let data = line.data(using: .utf8) {
                FileHandle.standardOutput.write(data)
            }
            return nil
        }
        return Unmanaged.passUnretained(event)
    }

    return Unmanaged.passUnretained(event)
}

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap, // .defaultTap allows the callback to drop events
    eventsOfInterest: eventMask,
    callback: callback,
    userInfo: stateRef
) else {
    FileHandle.standardError.write(
        "Failed to create event tap (Accessibility permission missing?)\n".data(using: .utf8)!
    )
    exit(1)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

// Signal readiness so the parent can stop waiting.
print("READY")

// Re-enable the tap if macOS pauses it (happens after extended idle).
let watchdog = Timer(timeInterval: 5.0, repeats: true) { _ in
    if !CGEvent.tapIsEnabled(tap: tap) {
        CGEvent.tapEnable(tap: tap, enable: true)
    }
}
RunLoop.current.add(watchdog, forMode: .common)

// Run until parent terminates us. Parent uses SIGTERM via child.kill().
signal(SIGTERM) { _ in
    print("EXIT")
    exit(0)
}
signal(SIGINT) { _ in
    print("EXIT")
    exit(0)
}

CFRunLoopRun()
