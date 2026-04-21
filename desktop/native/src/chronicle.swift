// chronicle - Background screen capture + OCR sidecar for Stella.
//
// One process model:
//   $ chronicle daemon --root <stellaHome> [--interval-ms 4000] [--max-strings 60]
//
// Lifecycle commands (sent to the running daemon over AF_UNIX):
//   $ chronicle start  --root <stellaHome>
//   $ chronicle pause  --root <stellaHome>
//   $ chronicle resume --root <stellaHome>
//   $ chronicle stop   --root <stellaHome>
//   $ chronicle status --root <stellaHome>
//
// State layout (all under <stellaHome>/state/chronicle/):
//   chronicle.sock            AF_UNIX command socket
//   chronicle.pid             Daemon pid (cleaned up on graceful exit)
//   chronicle.state.json      { running: bool, paused: bool, lastCaptureAt: ISO }
//   captures.jsonl            One line per OCR delta:
//                             { ts, displayId, addedLines: [..], removedLines: [..] }
//   summaries/<YYYY-MM-DD>.md Rolled daily summary (also mirrored to
//                             <stellaHome>/state/memories_extensions/chronicle/<DATE>.md)
//
// Permissions: requires Screen Recording (CGPreflightScreenCaptureAccess);
// the daemon refuses to start without it. The Electron host is responsible
// for prompting via macos-permissions.ts (TCC).
//
// Build:
//   swiftc -O -o out/darwin/chronicle src/chronicle.swift \
//     -framework AppKit -framework CoreGraphics -framework Foundation \
//     -framework ScreenCaptureKit -framework Vision

import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

// MARK: - Helpers

func eprint(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8) ?? Data())
}

func nowIsoTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

func todayDateString() -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: Date())
}

// MARK: - Args

struct ChronicleArgs {
    var command: String = ""
    var stellaHome: String = ""
    var intervalMs: Int = 4000
    var maxStrings: Int = 60
    var excludedBundleIds: [String] = []
}

func parseArgs() -> ChronicleArgs {
    var args = ChronicleArgs()
    let raw = Array(CommandLine.arguments.dropFirst())
    if let first = raw.first {
        args.command = first
    }
    var i = 1
    while i < raw.count {
        let arg = raw[i]
        if arg == "--root", i + 1 < raw.count {
            args.stellaHome = raw[i + 1]
            i += 2
        } else if arg.hasPrefix("--root=") {
            args.stellaHome = String(arg.dropFirst("--root=".count))
            i += 1
        } else if arg == "--interval-ms", i + 1 < raw.count {
            args.intervalMs = Int(raw[i + 1]) ?? args.intervalMs
            i += 2
        } else if arg.hasPrefix("--interval-ms=") {
            args.intervalMs = Int(String(arg.dropFirst("--interval-ms=".count))) ?? args.intervalMs
            i += 1
        } else if arg == "--max-strings", i + 1 < raw.count {
            args.maxStrings = Int(raw[i + 1]) ?? args.maxStrings
            i += 2
        } else if arg.hasPrefix("--max-strings=") {
            args.maxStrings = Int(String(arg.dropFirst("--max-strings=".count))) ?? args.maxStrings
            i += 1
        } else if arg == "--exclude-bundle-id", i + 1 < raw.count {
            args.excludedBundleIds.append(raw[i + 1])
            i += 2
        } else if arg.hasPrefix("--exclude-bundle-id=") {
            args.excludedBundleIds.append(String(arg.dropFirst("--exclude-bundle-id=".count)))
            i += 1
        } else {
            i += 1
        }
    }
    return args
}

let DEFAULT_EXCLUDED_BUNDLE_IDS: Set<String> = [
    "com.stella.app",
    "com.stella.desktop",
    "com.stella.runtime",
    "com.github.Electron",
]

func normalizedIdentifier(_ value: String?) -> String {
    return value?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased() ?? ""
}

func shouldExcludeOwningApplication(
    _ app: SCRunningApplication,
    excludedBundleIds: Set<String>
) -> Bool {
    let bundleId = normalizedIdentifier(app.bundleIdentifier)
    if !bundleId.isEmpty {
        if bundleId.hasPrefix("com.stella") { return true }
        if excludedBundleIds.contains(bundleId) { return true }
        if DEFAULT_EXCLUDED_BUNDLE_IDS.contains(bundleId) { return true }
    }
    let appName = normalizedIdentifier(app.applicationName)
    return appName.contains("stella")
}

// MARK: - Paths

struct ChroniclePaths {
    let root: String
    var stateDir: String { root + "/state/chronicle" }
    var sockPath: String { stateDir + "/chronicle.sock" }
    var pidPath: String { stateDir + "/chronicle.pid" }
    var statePath: String { stateDir + "/chronicle.state.json" }
    var capturesPath: String { stateDir + "/captures.jsonl" }
    var summariesDir: String { stateDir + "/summaries" }
    var extensionDir: String { root + "/state/memories_extensions/chronicle" }
    var instructionsPath: String { extensionDir + "/instructions.md" }

    func ensureDirectories() throws {
        let fm = FileManager.default
        try fm.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
        try fm.createDirectory(atPath: summariesDir, withIntermediateDirectories: true)
        try fm.createDirectory(atPath: extensionDir, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: instructionsPath) {
            try INSTRUCTIONS_TEMPLATE.write(toFile: instructionsPath, atomically: true, encoding: .utf8)
        }
    }
}

let INSTRUCTIONS_TEMPLATE = """
# Chronicle extension

The Chronicle sidecar samples the user's screen every few seconds, runs Vision
OCR, and writes the *changes* (added/removed text lines) to
`captures.jsonl`. The Node-side summarizer then produces three views of that
data, all dropped in this folder:

- `<DATE>.md`         — daily append-only log of newly-observed OCR lines
                         (raw, written by the Swift daemon).
- `10m-current.md`     — distilled summary of the **last ~10 minutes** of
                         activity. Refreshed every minute by chronicle-summarizer.
- `6h-current.md`      — distilled summary of the **last ~6 hours** of
                         activity. Refreshed every hour.

For the Dream agent: prefer `10m-current.md` and `6h-current.md` — they are
already paraphrased and grouped. Use `<DATE>.md` only as raw evidence when
the rolling summaries leave a gap. Ignore single-line spikes in the raw log;
trust repeated patterns. Do NOT quote raw OCR text verbatim into MEMORY.md —
it's noisy. Distill into one or two sentences per material context shift.
"""

// MARK: - State persistence

struct ChronicleState: Codable {
    var running: Bool
    var paused: Bool
    var lastCaptureAt: String?
}

func writeState(_ paths: ChroniclePaths, _ state: ChronicleState) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(state) {
        try? data.write(to: URL(fileURLWithPath: paths.statePath), options: .atomic)
    }
}

func readState(_ paths: ChroniclePaths) -> ChronicleState? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: paths.statePath)) else {
        return nil
    }
    return try? JSONDecoder().decode(ChronicleState.self, from: data)
}

// MARK: - Permissions

func hasScreenRecordingPermission() -> Bool {
    return CGPreflightScreenCaptureAccess()
}

func requestScreenRecordingPermission() {
    _ = CGRequestScreenCaptureAccess()
}

// MARK: - Capture session

actor CaptureSession {
    private var paused: Bool = false
    private var lastLines: Set<String> = []
    private let paths: ChroniclePaths
    private let intervalMs: Int
    private let maxStrings: Int
    private let excludedBundleIds: Set<String>
    private var task: Task<Void, Never>?

    init(
        paths: ChroniclePaths,
        intervalMs: Int,
        maxStrings: Int,
        excludedBundleIds: Set<String>
    ) {
        self.paths = paths
        self.intervalMs = intervalMs
        self.maxStrings = maxStrings
        self.excludedBundleIds = excludedBundleIds
    }

    func setPaused(_ value: Bool) {
        paused = value
        var state = readState(paths) ?? ChronicleState(running: true, paused: value, lastCaptureAt: nil)
        state.paused = value
        writeState(paths, state)
    }

    func isPaused() -> Bool { paused }

    func start() {
        if task != nil { return }
        task = Task {
            await runLoop()
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func runLoop() async {
        while !Task.isCancelled {
            if paused {
                try? await Task.sleep(nanoseconds: UInt64(intervalMs) * 1_000_000)
                continue
            }
            do {
                try await captureOnce()
            } catch {
                eprint("chronicle.capture.failed: \(error)")
            }
            try? await Task.sleep(nanoseconds: UInt64(intervalMs) * 1_000_000)
        }
    }

    private func captureOnce() async throws {
        // Pick the first display.
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let display = content.displays.first else { return }

        // Filter Stella-owned windows out of the capture so we don't OCR our
        // own overlays/chat back into Dream.
        let excluded = content.windows.filter { window in
            if let app = window.owningApplication {
                return shouldExcludeOwningApplication(
                    app,
                    excludedBundleIds: excludedBundleIds
                )
            }
            return false
        }
        let filter = SCContentFilter(display: display, excludingWindows: excluded)

        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 1
        config.showsCursor = false
        config.pixelFormat = kCVPixelFormatType_32BGRA

        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
        } catch {
            return
        }

        // Run fast OCR.
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try? handler.perform([request])

        guard let observations = request.results else { return }
        var current: Set<String> = []
        for obs in observations {
            guard let candidate = obs.topCandidates(1).first else { continue }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.count < 3 { continue }
            current.insert(text)
            if current.count >= maxStrings { break }
        }

        let added = current.subtracting(lastLines)
        let removed = lastLines.subtracting(current)
        lastLines = current

        if added.isEmpty && removed.isEmpty {
            // Still record a heartbeat in state so Electron can see we're alive,
            // but don't bloat captures.jsonl with empty lines.
            var state = readState(paths) ?? ChronicleState(running: true, paused: false, lastCaptureAt: nil)
            state.lastCaptureAt = nowIsoTimestamp()
            writeState(paths, state)
            return
        }

        let entry: [String: Any] = [
            "ts": nowIsoTimestamp(),
            "displayId": "\(display.displayID)",
            "addedLines": Array(added.prefix(maxStrings)),
            "removedLines": Array(removed.prefix(maxStrings)),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: entry, options: []) {
            appendLine(paths.capturesPath, data)
        }

        appendDailySummary(paths: paths, added: added)

        var state = readState(paths) ?? ChronicleState(running: true, paused: false, lastCaptureAt: nil)
        state.lastCaptureAt = nowIsoTimestamp()
        writeState(paths, state)
    }

    private func appendLine(_ path: String, _ data: Data) {
        let url = URL(fileURLWithPath: path)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            handle.seekToEndOfFile()
            handle.write(data)
            handle.write("\n".data(using: .utf8) ?? Data())
        } else {
            var bytes = data
            bytes.append("\n".data(using: .utf8) ?? Data())
            try? bytes.write(to: url)
        }
    }

    private func appendDailySummary(paths: ChroniclePaths, added: Set<String>) {
        if added.isEmpty { return }
        let date = todayDateString()
        let summaryPath = paths.summariesDir + "/\(date).md"
        let extPath = paths.extensionDir + "/\(date).md"

        let prefix = """
# Chronicle \(date)

> Daily rollup of new on-screen text lines observed by Chronicle. Append-only.
> Consumed by the Dream agent (see ../instructions.md).

"""
        for path in [summaryPath, extPath] {
            if !FileManager.default.fileExists(atPath: path) {
                try? prefix.write(toFile: path, atomically: true, encoding: .utf8)
            }
            if let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path)) {
                defer { try? handle.close() }
                handle.seekToEndOfFile()
                let block = "## \(nowIsoTimestamp())\n" +
                    added.prefix(20).map { "- \($0)" }.joined(separator: "\n") +
                    "\n\n"
                handle.write(block.data(using: .utf8) ?? Data())
            }
        }
    }
}

// MARK: - AF_UNIX command server

func makeUnixSocket(path: String, listen: Bool) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { return -1 }
    if listen {
        unlink(path)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: 104) { dst in
                for (idx, byte) in pathBytes.enumerated() where idx < 103 {
                    dst[idx] = CChar(byte)
                }
                dst[min(pathBytes.count, 103)] = 0
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, len)
            }
        }
        if bindResult < 0 {
            close(fd)
            return -1
        }
        if Darwin.listen(fd, 8) < 0 {
            close(fd)
            return -1
        }
    } else {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: 104) { dst in
                for (idx, byte) in pathBytes.enumerated() where idx < 103 {
                    dst[idx] = CChar(byte)
                }
                dst[min(pathBytes.count, 103)] = 0
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, len)
            }
        }
        if connectResult < 0 {
            close(fd)
            return -1
        }
    }
    return fd
}

func recvLine(_ fd: Int32, maxBytes: Int = 4096) -> String? {
    var buffer = [UInt8](repeating: 0, count: maxBytes)
    let n = recv(fd, &buffer, maxBytes - 1, 0)
    if n <= 0 { return nil }
    buffer[n] = 0
    return String(bytes: buffer.prefix(Int(n)), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func sendString(_ fd: Int32, _ s: String) {
    let data = (s + "\n").data(using: .utf8) ?? Data()
    _ = data.withUnsafeBytes { ptr in
        send(fd, ptr.baseAddress, data.count, 0)
    }
}

// MARK: - Daemon

func runDaemon(
    paths: ChroniclePaths,
    intervalMs: Int,
    maxStrings: Int,
    excludedBundleIds: [String]
) async {
    do {
        try paths.ensureDirectories()
    } catch {
        eprint("chronicle.daemon.dir-error: \(error)")
        exit(1)
    }

    if !hasScreenRecordingPermission() {
        eprint("chronicle.daemon: missing Screen Recording permission")
        // Touch state so callers can see we tried.
        writeState(paths, ChronicleState(running: false, paused: false, lastCaptureAt: nil))
        exit(2)
    }

    try? "\(getpid())".write(toFile: paths.pidPath, atomically: true, encoding: .utf8)
    writeState(paths, ChronicleState(running: true, paused: false, lastCaptureAt: nil))

    let session = CaptureSession(
        paths: paths,
        intervalMs: intervalMs,
        maxStrings: maxStrings,
        excludedBundleIds: Set(excludedBundleIds.map { normalizedIdentifier($0) })
    )
    await session.start()

    let serverFd = makeUnixSocket(path: paths.sockPath, listen: true)
    if serverFd < 0 {
        eprint("chronicle.daemon: failed to bind socket at \(paths.sockPath)")
        await session.stop()
        exit(3)
    }

    // Handle SIGTERM/SIGINT cleanly.
    let shutdown: @Sendable () -> Void = {
        try? FileManager.default.removeItem(atPath: paths.pidPath)
        try? FileManager.default.removeItem(atPath: paths.sockPath)
        var state = readState(paths) ?? ChronicleState(running: false, paused: false, lastCaptureAt: nil)
        state.running = false
        writeState(paths, state)
    }
    let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM)
    sigtermSource.setEventHandler {
        shutdown()
        exit(0)
    }
    sigtermSource.resume()
    signal(SIGTERM, SIG_IGN)

    let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT)
    sigintSource.setEventHandler {
        shutdown()
        exit(0)
    }
    sigintSource.resume()
    signal(SIGINT, SIG_IGN)

    while true {
        let clientFd = accept(serverFd, nil, nil)
        if clientFd < 0 {
            // Briefly back off on accept errors.
            try? await Task.sleep(nanoseconds: 100_000_000)
            continue
        }
        Task {
            defer { close(clientFd) }
            guard let line = recvLine(clientFd) else { return }
            switch line {
            case "ping":
                sendString(clientFd, "pong")
            case "pause":
                await session.setPaused(true)
                sendString(clientFd, "ok")
            case "resume":
                await session.setPaused(false)
                sendString(clientFd, "ok")
            case "status":
                let state = readState(paths) ?? ChronicleState(running: true, paused: false, lastCaptureAt: nil)
                let payload: [String: Any] = [
                    "running": state.running,
                    "paused": state.paused,
                    "lastCaptureAt": state.lastCaptureAt ?? "",
                    "fps": Double(1000) / Double(max(intervalMs, 1)),
                    "pid": getpid(),
                ]
                if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
                   let str = String(data: data, encoding: .utf8) {
                    sendString(clientFd, str)
                } else {
                    sendString(clientFd, "{}")
                }
            case "stop":
                sendString(clientFd, "ok")
                await session.stop()
                shutdown()
                exit(0)
            default:
                sendString(clientFd, "unknown")
            }
        }
    }
}

// MARK: - Client commands

func sendCommand(_ paths: ChroniclePaths, _ command: String) {
    let fd = makeUnixSocket(path: paths.sockPath, listen: false)
    if fd < 0 {
        eprint("chronicle: daemon not reachable at \(paths.sockPath)")
        exit(4)
    }
    defer { close(fd) }
    sendString(fd, command)
    if let reply = recvLine(fd) {
        print(reply)
    }
}

// MARK: - Main

let args = parseArgs()
if args.stellaHome.isEmpty {
    eprint("chronicle: --root <stellaHome> is required")
    exit(64)
}
let paths = ChroniclePaths(root: args.stellaHome)

switch args.command {
case "daemon":
    let runtime = RunLoop.current
    Task {
        await runDaemon(
            paths: paths,
            intervalMs: args.intervalMs,
            maxStrings: args.maxStrings,
            excludedBundleIds: args.excludedBundleIds
        )
    }
    while true {
        runtime.run(mode: .default, before: Date.distantFuture)
    }
case "start":
    sendCommand(paths, "resume")
case "pause":
    sendCommand(paths, "pause")
case "resume":
    sendCommand(paths, "resume")
case "stop":
    sendCommand(paths, "stop")
case "status":
    sendCommand(paths, "status")
case "ping":
    sendCommand(paths, "ping")
default:
    eprint("chronicle: unknown command '\(args.command)'")
    eprint("Usage: chronicle {daemon|start|pause|resume|stop|status|ping} --root <stellaHome>")
    exit(64)
}
