// meeting_capture - Granola-style dual-stream meeting recorder for Stella.
//
// Captures system audio (everyone else on the call, no meeting bot required)
// via ScreenCaptureKit AND the local microphone (you) via AVAudioEngine, as two
// independent PCM streams written to disk as rolling WAV segments. Keeping the
// two streams separate is deliberate: it gives a downstream transcriber clean
// "you vs them" speaker separation for free.
//
// This helper only does capture-to-disk. Transcription and note enhancement
// live elsewhere (a skill / agent step); this binary stays dumb, robust, and
// independent of any renderer window so a recording survives the UI closing,
// reloading, or crashing — same daemon model as `chronicle`.
//
// One process model:
//   $ meeting_capture daemon --root <stellaHome> [--segment-seconds 30]
//
// Lifecycle commands (sent to the running daemon over AF_UNIX):
//   $ meeting_capture start    --root <stellaHome> [--session-id <id>] [--segment-seconds N]
//   $ meeting_capture pause    --root <stellaHome>
//   $ meeting_capture resume   --root <stellaHome>
//   $ meeting_capture stop     --root <stellaHome>   # ends recording, daemon lives on
//   $ meeting_capture status   --root <stellaHome>
//   $ meeting_capture ping     --root <stellaHome>
//   $ meeting_capture shutdown --root <stellaHome>   # finalize + exit
//
// State layout (all under <stellaHome>/meetings/):
//   meeting_capture.sock          AF_UNIX command socket
//   meeting_capture.pid           Daemon pid (cleaned up on graceful exit)
//   meeting_capture.state.json    { running, recording, paused, sessionId, startedAtMs, segmentSeconds }
//   <sessionId>/                  One folder per recording
//     session.json                { sessionId, startedAtMs, endedAtMs, segmentSeconds, streams: {...} }
//     segments.jsonl              One line per finalized WAV segment
//     system/seg-<idx>-<startMs>.wav
//     mic/seg-<idx>-<startMs>.wav
//
// Permissions: system audio needs Screen Recording (CGPreflightScreenCaptureAccess);
// the mic needs Microphone access. The Electron host prompts for both via TCC
// before starting a recording (macos-permissions.ts). The daemon itself runs
// idle without permission and only fails the `start` command if Screen Recording
// is missing; the mic is best-effort (a recording still works system-audio-only).
//
// Build:
//   swiftc -O -o out/darwin/meeting_capture src/meeting_capture.swift \
//     -framework AVFoundation -framework AppKit -framework CoreAudio \
//     -framework CoreMedia -framework Foundation -framework ScreenCaptureKit

import AVFoundation
import AppKit
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - Helpers

func eprint(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8) ?? Data())
}

func nowMs() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
}

func nowIsoTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

func jsonLine(_ values: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]),
          let str = String(data: data, encoding: .utf8) else {
        return "{}"
    }
    return str
}

// MARK: - Args

struct MeetingArgs {
    var command: String = ""
    var stellaHome: String = ""
    var sessionId: String?
    var segmentSeconds: Int = 30
}

func parseArgs() -> MeetingArgs {
    var args = MeetingArgs()
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
        } else if arg == "--session-id", i + 1 < raw.count {
            args.sessionId = raw[i + 1]
            i += 2
        } else if arg.hasPrefix("--session-id=") {
            args.sessionId = String(arg.dropFirst("--session-id=".count))
            i += 1
        } else if arg == "--segment-seconds", i + 1 < raw.count {
            args.segmentSeconds = Int(raw[i + 1]) ?? args.segmentSeconds
            i += 2
        } else if arg.hasPrefix("--segment-seconds=") {
            args.segmentSeconds = Int(String(arg.dropFirst("--segment-seconds=".count))) ?? args.segmentSeconds
            i += 1
        } else {
            i += 1
        }
    }
    return args
}

func generateSessionId() -> String {
    let suffix = String(UInt32.random(in: 0..<0xFFFF), radix: 16)
    return "mtg-\(nowMs())-\(suffix)"
}

func sanitizeSessionId(_ id: String) -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    let cleaned = String(id.unicodeScalars.filter { allowed.contains($0) })
    return cleaned.isEmpty ? generateSessionId() : cleaned
}

// MARK: - Paths

struct MeetingPaths {
    let root: String
    var stateDir: String { root + "/meetings" }
    var sockPath: String { stateDir + "/meeting_capture.sock" }
    var pidPath: String { stateDir + "/meeting_capture.pid" }
    var statePath: String { stateDir + "/meeting_capture.state.json" }

    func sessionDir(_ id: String) -> String { stateDir + "/" + id }

    func ensureStateDir() throws {
        try FileManager.default.createDirectory(
            atPath: stateDir,
            withIntermediateDirectories: true
        )
    }
}

// MARK: - State persistence

struct MeetingState: Codable {
    var running: Bool
    var recording: Bool
    var paused: Bool
    var sessionId: String?
    var startedAtMs: Int64?
    var segmentSeconds: Int
}

func writeState(_ paths: MeetingPaths, _ state: MeetingState) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(state) {
        try? data.write(to: URL(fileURLWithPath: paths.statePath), options: .atomic)
    }
}

func readState(_ paths: MeetingPaths) -> MeetingState? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: paths.statePath)) else {
        return nil
    }
    return try? JSONDecoder().decode(MeetingState.self, from: data)
}

// MARK: - Permissions

func hasScreenRecordingPermission() -> Bool {
    CGPreflightScreenCaptureAccess()
}

func ensureMicrophoneAccess() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return true
    case .notDetermined:
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            granted = ok
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 10)
        return granted
    default:
        return false
    }
}

// MARK: - PCM conversion

/// Pack non-interleaved float channel data into interleaved little-endian Int16.
func interleaveInt16(frames: Int, channels: Int, sample: (Int, Int) -> Float) -> Data {
    guard frames > 0, channels > 0 else { return Data() }
    var out = Data(count: frames * channels * MemoryLayout<Int16>.size)
    out.withUnsafeMutableBytes { rawBuffer in
        let dst = rawBuffer.bindMemory(to: Int16.self)
        var idx = 0
        for frame in 0..<frames {
            for channel in 0..<channels {
                let clamped = max(-1.0, min(1.0, sample(frame, channel)))
                dst[idx] = Int16(clamped * 32767.0)
                idx += 1
            }
        }
    }
    return out
}

struct PCMChunk {
    let data: Data
    let sampleRate: UInt32
    let channels: UInt16
}

/// Convert a ScreenCaptureKit audio CMSampleBuffer (Float32, usually
/// non-interleaved stereo at 48kHz) into interleaved Int16 PCM.
func pcmFromSampleBuffer(_ sampleBuffer: CMSampleBuffer) -> PCMChunk? {
    guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)
    else { return nil }
    let asbd = asbdPtr.pointee
    let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
    guard isFloat else { return nil }
    let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    let channelCount = max(Int(asbd.mChannelsPerFrame), 1)
    let sampleRate = UInt32(asbd.mSampleRate)
    guard sampleRate > 0 else { return nil }

    var blockBuffer: CMBlockBuffer?
    let ablPtr = AudioBufferList.allocate(maximumBuffers: channelCount)
    defer { free(ablPtr.unsafeMutablePointer) }

    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: nil,
        bufferListOut: ablPtr.unsafeMutablePointer,
        bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: channelCount),
        blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
        blockBufferOut: &blockBuffer
    )
    guard status == noErr, blockBuffer != nil else { return nil }

    if isNonInterleaved {
        let buffers = Array(ablPtr)
        guard let first = buffers.first, first.mData != nil else { return nil }
        let frames = Int(first.mDataByteSize) / MemoryLayout<Float>.size
        guard frames > 0 else { return nil }
        let channelPtrs: [UnsafeMutablePointer<Float>] = buffers.compactMap { buffer in
            buffer.mData?.assumingMemoryBound(to: Float.self)
        }
        guard channelPtrs.count == buffers.count else { return nil }
        let data = interleaveInt16(frames: frames, channels: channelPtrs.count) { frame, channel in
            channelPtrs[channel][frame]
        }
        return PCMChunk(data: data, sampleRate: sampleRate, channels: UInt16(channelPtrs.count))
    } else {
        guard let buffer = ablPtr.first, let base = buffer.mData else { return nil }
        let floats = base.assumingMemoryBound(to: Float.self)
        let totalSamples = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
        let frames = totalSamples / channelCount
        guard frames > 0 else { return nil }
        let data = interleaveInt16(frames: frames, channels: channelCount) { frame, channel in
            floats[frame * channelCount + channel]
        }
        return PCMChunk(data: data, sampleRate: sampleRate, channels: UInt16(channelCount))
    }
}

/// Convert an AVAudioEngine microphone buffer (non-interleaved Float32) into
/// interleaved Int16 PCM.
func pcmFromAudioBuffer(_ buffer: AVAudioPCMBuffer) -> PCMChunk? {
    guard let channelData = buffer.floatChannelData else { return nil }
    let channels = Int(buffer.format.channelCount)
    let frames = Int(buffer.frameLength)
    let sampleRate = UInt32(buffer.format.sampleRate)
    guard channels > 0, frames > 0, sampleRate > 0 else { return nil }
    let data = interleaveInt16(frames: frames, channels: channels) { frame, channel in
        channelData[channel][frame]
    }
    return PCMChunk(data: data, sampleRate: sampleRate, channels: UInt16(channels))
}

// MARK: - WAV writer

/// Streams interleaved Int16 PCM to a .wav file, patching the RIFF/data sizes
/// on close. Single-threaded; only touched from the recorder's serial io queue.
final class WavWriter {
    let path: String
    let sampleRate: UInt32
    let channels: UInt16
    let startedAtMs: Int64
    private let handle: FileHandle
    private(set) var dataBytes: UInt32 = 0
    private let bitsPerSample: UInt16 = 16

    init?(path: String, sampleRate: UInt32, channels: UInt16, startedAtMs: Int64) {
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let handle = FileHandle(forWritingAtPath: path) else { return nil }
        self.handle = handle
        self.path = path
        self.sampleRate = sampleRate
        self.channels = channels
        self.startedAtMs = startedAtMs
        writePlaceholderHeader()
    }

    private func u32(_ value: UInt32) -> Data {
        var v = value.littleEndian
        return Data(bytes: &v, count: 4)
    }

    private func u16(_ value: UInt16) -> Data {
        var v = value.littleEndian
        return Data(bytes: &v, count: 2)
    }

    private func writePlaceholderHeader() {
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        var header = Data()
        header.append("RIFF".data(using: .ascii)!)
        header.append(u32(0)) // chunk size, patched on close
        header.append("WAVE".data(using: .ascii)!)
        header.append("fmt ".data(using: .ascii)!)
        header.append(u32(16)) // PCM fmt chunk size
        header.append(u16(1)) // audio format = PCM
        header.append(u16(channels))
        header.append(u32(sampleRate))
        header.append(u32(byteRate))
        header.append(u16(blockAlign))
        header.append(u16(bitsPerSample))
        header.append("data".data(using: .ascii)!)
        header.append(u32(0)) // data size, patched on close
        handle.write(header)
    }

    func append(_ pcm: Data) {
        guard !pcm.isEmpty else { return }
        handle.write(pcm)
        dataBytes &+= UInt32(pcm.count)
    }

    /// Finalize sizes and close. Returns the wall-clock duration in ms.
    func close() -> Int64 {
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        do {
            try handle.seek(toOffset: 4)
            handle.write(u32(36 &+ dataBytes))
            try handle.seek(toOffset: 40)
            handle.write(u32(dataBytes))
        } catch {
            // best-effort; an unpatched header still has valid audio bytes
        }
        try? handle.close()
        guard byteRate > 0 else { return 0 }
        return Int64(Double(dataBytes) / Double(byteRate) * 1000.0)
    }
}

// MARK: - Per-stream segmenter

/// Owns the rolling WAV segments for a single stream ("system" or "mic").
final class StreamSegmenter {
    let streamName: String
    let dir: String
    let segmentSeconds: Int
    let segmentsLogPath: String
    private(set) var sampleRate: UInt32 = 0
    private(set) var channels: UInt16 = 0
    private(set) var segmentCount: Int = 0
    private var current: WavWriter?
    private var index: Int = 0

    init(streamName: String, sessionDir: String, segmentsLogPath: String, segmentSeconds: Int) {
        self.streamName = streamName
        self.dir = sessionDir + "/" + streamName
        self.segmentsLogPath = segmentsLogPath
        self.segmentSeconds = max(segmentSeconds, 1)
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }

    func ingest(_ chunk: PCMChunk) {
        if sampleRate == 0 {
            sampleRate = chunk.sampleRate
            channels = chunk.channels
        }
        let now = nowMs()
        if let writer = current {
            if now - writer.startedAtMs >= Int64(segmentSeconds) * 1000 {
                finalizeCurrent(endedAtMs: now)
            }
        }
        if current == nil {
            let startMs = now
            let path = dir + "/seg-\(index)-\(startMs).wav"
            current = WavWriter(
                path: path,
                sampleRate: chunk.sampleRate,
                channels: chunk.channels,
                startedAtMs: startMs
            )
        }
        current?.append(chunk.data)
    }

    /// Close the active segment (e.g. on pause / stop) so gaps are explicit.
    func finalizeCurrent(endedAtMs: Int64) {
        guard let writer = current else { return }
        let durationMs = writer.close()
        appendSegmentLog([
            "stream": streamName,
            "index": index,
            "file": (writer.path as NSString).lastPathComponent,
            "startedAtMs": writer.startedAtMs,
            "endedAtMs": endedAtMs,
            "durationMs": durationMs,
            "sampleRate": Int(writer.sampleRate),
            "channels": Int(writer.channels),
        ])
        index += 1
        segmentCount += 1
        current = nil
    }

    private func appendSegmentLog(_ entry: [String: Any]) {
        let line = jsonLine(entry) + "\n"
        guard let data = line.data(using: .utf8) else { return }
        let url = URL(fileURLWithPath: segmentsLogPath)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            handle.seekToEndOfFile()
            handle.write(data)
        } else {
            try? data.write(to: url)
        }
    }
}

// MARK: - System audio output

/// Forwards ScreenCaptureKit audio sample buffers to a sink closure.
final class SystemAudioOutput: NSObject, SCStreamOutput {
    private let onAudio: (CMSampleBuffer) -> Void

    init(onAudio: @escaping (CMSampleBuffer) -> Void) {
        self.onAudio = onAudio
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return } // video frames are intentionally dropped
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        onAudio(sampleBuffer)
    }
}

// MARK: - Recorder

/// Owns the active recording: one SCStream (system audio) + one AVAudioEngine
/// (mic), funneling both into per-stream segmenters on a serial io queue.
final class MeetingRecorder: NSObject, SCStreamDelegate {
    private let paths: MeetingPaths
    private let ioQueue = DispatchQueue(label: "com.stella.meeting_capture.io")
    private let audioQueue = DispatchQueue(label: "com.stella.meeting_capture.audio")

    private var recording = false
    private var paused = false
    private var sessionId: String?
    private var sessionDir: String?
    private var startedAtMs: Int64 = 0
    private var segmentSeconds = 30

    private var systemSegmenter: StreamSegmenter?
    private var micSegmenter: StreamSegmenter?

    private var scStream: SCStream?
    private var systemOutput: SystemAudioOutput?
    private let audioEngine = AVAudioEngine()
    private var micActive = false

    init(paths: MeetingPaths) {
        self.paths = paths
    }

    var isRecording: Bool { ioQueue.sync { recording } }

    func snapshotState(running: Bool) -> MeetingState {
        ioQueue.sync {
            MeetingState(
                running: running,
                recording: recording,
                paused: paused,
                sessionId: sessionId,
                startedAtMs: recording ? startedAtMs : nil,
                segmentSeconds: segmentSeconds
            )
        }
    }

    // MARK: Lifecycle

    func start(requestedId: String?, segmentSeconds: Int) -> [String: Any] {
        if ioQueue.sync(execute: { recording }) {
            return ["ok": false, "error": "already-recording"]
        }
        if !hasScreenRecordingPermission() {
            return ["ok": false, "error": "needs-screen-permission"]
        }

        let id = requestedId.map(sanitizeSessionId) ?? generateSessionId()
        let dir = paths.sessionDir(id)
        do {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        } catch {
            return ["ok": false, "error": "session-dir-failed"]
        }

        let started = nowMs()
        let segLog = dir + "/segments.jsonl"
        let system = StreamSegmenter(
            streamName: "system",
            sessionDir: dir,
            segmentsLogPath: segLog,
            segmentSeconds: segmentSeconds
        )
        let mic = StreamSegmenter(
            streamName: "mic",
            sessionDir: dir,
            segmentsLogPath: segLog,
            segmentSeconds: segmentSeconds
        )

        ioQueue.sync {
            self.recording = true
            self.paused = false
            self.sessionId = id
            self.sessionDir = dir
            self.startedAtMs = started
            self.segmentSeconds = segmentSeconds
            self.systemSegmenter = system
            self.micSegmenter = mic
        }

        let systemStarted = startSystemAudio()
        let micStarted = startMicrophone()
        if !systemStarted && !micStarted {
            // Nothing captured — roll the session back so we don't leave a
            // ghost recording the host thinks is live.
            _ = stop()
            return ["ok": false, "error": "no-audio-streams"]
        }

        writeSessionJson(ended: false)
        return [
            "ok": true,
            "sessionId": id,
            "dir": dir,
            "segmentSeconds": segmentSeconds,
            "system": systemStarted,
            "mic": micStarted,
            "startedAtMs": started,
        ]
    }

    func setPaused(_ value: Bool) -> Bool {
        ioQueue.sync {
            guard recording else { return }
            paused = value
            if value {
                let now = nowMs()
                systemSegmenter?.finalizeCurrent(endedAtMs: now)
                micSegmenter?.finalizeCurrent(endedAtMs: now)
            }
        }
        return ioQueue.sync { recording }
    }

    func stop() -> [String: Any] {
        let wasRecording = ioQueue.sync { recording }
        if !wasRecording {
            return ["ok": false, "error": "not-recording"]
        }

        // Tear down the live capture before closing files so no late frame
        // lands after finalize.
        if let stream = scStream {
            let semaphore = DispatchSemaphore(value: 0)
            stream.stopCapture { _ in semaphore.signal() }
            _ = semaphore.wait(timeout: .now() + 3)
        }
        scStream = nil
        systemOutput = nil
        if micActive {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
            micActive = false
        }

        let result: [String: Any] = ioQueue.sync {
            let endedAt = nowMs()
            systemSegmenter?.finalizeCurrent(endedAtMs: endedAt)
            micSegmenter?.finalizeCurrent(endedAtMs: endedAt)
            let id = sessionId ?? ""
            let dir = sessionDir ?? ""
            let durationMs = endedAt - startedAtMs
            let systemSegments = systemSegmenter?.segmentCount ?? 0
            let micSegments = micSegmenter?.segmentCount ?? 0
            return [
                "ok": true,
                "sessionId": id,
                "dir": dir,
                "durationMs": durationMs,
                "systemSegments": systemSegments,
                "micSegments": micSegments,
            ]
        }

        writeSessionJson(ended: true)

        ioQueue.sync {
            recording = false
            paused = false
            sessionId = nil
            sessionDir = nil
            startedAtMs = 0
            systemSegmenter = nil
            micSegmenter = nil
        }
        return result
    }

    // MARK: Ingestion

    private func ingestSystem(_ sampleBuffer: CMSampleBuffer) {
        guard let chunk = pcmFromSampleBuffer(sampleBuffer) else { return }
        ioQueue.async {
            guard self.recording, !self.paused else { return }
            self.systemSegmenter?.ingest(chunk)
        }
    }

    private func ingestMic(_ buffer: AVAudioPCMBuffer) {
        guard let chunk = pcmFromAudioBuffer(buffer) else { return }
        ioQueue.async {
            guard self.recording, !self.paused else { return }
            self.micSegmenter?.ingest(chunk)
        }
    }

    // MARK: System audio (ScreenCaptureKit)

    private func startSystemAudio() -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        Task {
            ok = await self.configureAndStartSystemAudio()
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 8)
        return ok
    }

    private func configureAndStartSystemAudio() async -> Bool {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
            guard let display = content.displays.first else { return false }

            // Exclude Stella's own apps from the screen content. System audio
            // from our own process is dropped separately via
            // excludesCurrentProcessAudio below.
            let stellaApps = content.applications.filter { app in
                let bundle = app.bundleIdentifier.lowercased()
                return bundle.hasPrefix("com.stella") || bundle == "com.github.electron"
            }
            let filter = SCContentFilter(
                display: display,
                excludingApplications: stellaApps,
                exceptingWindows: []
            )

            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.sampleRate = 48_000
            config.channelCount = 2
            config.excludesCurrentProcessAudio = true
            // We only want audio. SCStream still produces video, so keep it as
            // cheap as possible: tiny frames, slow cadence, dropped on arrival.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.queueDepth = 6
            config.showsCursor = false

            let output = SystemAudioOutput { [weak self] sampleBuffer in
                self?.ingestSystem(sampleBuffer)
            }
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: audioQueue)
            try await stream.startCapture()

            self.scStream = stream
            self.systemOutput = output
            return true
        } catch {
            eprint("meeting_capture.system-audio.failed: \(error)")
            return false
        }
    }

    // MARK: Microphone (AVAudioEngine)

    private func startMicrophone() -> Bool {
        guard ensureMicrophoneAccess() else {
            eprint("meeting_capture.mic: microphone access denied")
            return false
        }
        let input = audioEngine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            eprint("meeting_capture.mic: no usable input format")
            return false
        }
        input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [weak self] buffer, _ in
            self?.ingestMic(buffer)
        }
        do {
            audioEngine.prepare()
            try audioEngine.start()
            micActive = true
            return true
        } catch {
            eprint("meeting_capture.mic.failed: \(error)")
            input.removeTap(onBus: 0)
            return false
        }
    }

    // MARK: session.json

    private func writeSessionJson(ended: Bool) {
        let snapshot: (String, String, Int64, Int, StreamSegmenter?, StreamSegmenter?) = ioQueue.sync {
            (
                sessionId ?? "",
                sessionDir ?? "",
                startedAtMs,
                segmentSeconds,
                systemSegmenter,
                micSegmenter
            )
        }
        let (id, dir, started, segSeconds, system, mic) = snapshot
        guard !dir.isEmpty else { return }

        func streamMeta(_ segmenter: StreamSegmenter?) -> [String: Any] {
            guard let segmenter else { return ["available": false] }
            return [
                "available": segmenter.sampleRate > 0,
                "sampleRate": Int(segmenter.sampleRate),
                "channels": Int(segmenter.channels),
                "segments": segmenter.segmentCount,
            ]
        }

        var payload: [String: Any] = [
            "sessionId": id,
            "startedAtMs": started,
            "startedAt": nowIsoTimestamp(),
            "segmentSeconds": segSeconds,
            "streams": [
                "system": streamMeta(system),
                "mic": streamMeta(mic),
            ],
        ]
        if ended {
            let endedAt = nowMs()
            payload["endedAtMs"] = endedAt
            payload["durationMs"] = endedAt - started
        }

        let encoded = jsonLine(payload)
        try? encoded.write(toFile: dir + "/session.json", atomically: true, encoding: .utf8)
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        eprint("meeting_capture.system-audio.stopped: \(error)")
    }
}

// MARK: - AF_UNIX command server

func makeUnixSocket(path: String, listen: Bool) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { return -1 }
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
    if listen {
        unlink(path)
        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, len)
            }
        }
        if bindResult < 0 { close(fd); return -1 }
        if Darwin.listen(fd, 8) < 0 { close(fd); return -1 }
    } else {
        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, len)
            }
        }
        if connectResult < 0 { close(fd); return -1 }
    }
    return fd
}

func recvLine(_ fd: Int32, maxBytes: Int = 4096) -> String? {
    var buffer = [UInt8](repeating: 0, count: maxBytes)
    let n = recv(fd, &buffer, maxBytes - 1, 0)
    if n <= 0 { return nil }
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

func runDaemon(paths: MeetingPaths, defaultSegmentSeconds: Int) {
    do {
        try paths.ensureStateDir()
    } catch {
        eprint("meeting_capture.daemon.dir-error: \(error)")
        exit(1)
    }

    try? "\(getpid())".write(toFile: paths.pidPath, atomically: true, encoding: .utf8)

    let recorder = MeetingRecorder(paths: paths)
    writeState(paths, recorder.snapshotState(running: true))

    let serverFd = makeUnixSocket(path: paths.sockPath, listen: true)
    if serverFd < 0 {
        eprint("meeting_capture.daemon: failed to bind socket at \(paths.sockPath)")
        exit(3)
    }

    let shutdown: @Sendable () -> Void = {
        if recorder.isRecording {
            _ = recorder.stop()
        }
        try? FileManager.default.removeItem(atPath: paths.pidPath)
        try? FileManager.default.removeItem(atPath: paths.sockPath)
        var state = recorder.snapshotState(running: false)
        state.running = false
        writeState(paths, state)
    }

    let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM)
    sigtermSource.setEventHandler { shutdown(); exit(0) }
    sigtermSource.resume()
    signal(SIGTERM, SIG_IGN)

    let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT)
    sigintSource.setEventHandler { shutdown(); exit(0) }
    sigintSource.resume()
    signal(SIGINT, SIG_IGN)

    let acceptQueue = DispatchQueue(label: "com.stella.meeting_capture.accept")
    acceptQueue.async {
        while true {
            let clientFd = accept(serverFd, nil, nil)
            if clientFd < 0 {
                usleep(100_000)
                continue
            }
            defer { close(clientFd) }
            guard let line = recvLine(clientFd) else { continue }
            let parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            let command = parts.first ?? ""

            switch command {
            case "ping":
                sendString(clientFd, "pong")
            case "start":
                var requestedId: String?
                if parts.count > 1, parts[1] != "-" { requestedId = parts[1] }
                var seg = defaultSegmentSeconds
                if parts.count > 2, let parsed = Int(parts[2]), parsed > 0 { seg = parsed }
                let result = recorder.start(requestedId: requestedId, segmentSeconds: seg)
                writeState(paths, recorder.snapshotState(running: true))
                sendString(clientFd, jsonLine(result))
            case "pause":
                let ok = recorder.setPaused(true)
                writeState(paths, recorder.snapshotState(running: true))
                sendString(clientFd, jsonLine(["ok": ok]))
            case "resume":
                let ok = recorder.setPaused(false)
                writeState(paths, recorder.snapshotState(running: true))
                sendString(clientFd, jsonLine(["ok": ok]))
            case "stop":
                let result = recorder.stop()
                writeState(paths, recorder.snapshotState(running: true))
                sendString(clientFd, jsonLine(result))
            case "status":
                let state = recorder.snapshotState(running: true)
                sendString(clientFd, jsonLine([
                    "running": true,
                    "recording": state.recording,
                    "paused": state.paused,
                    "sessionId": state.sessionId ?? "",
                    "startedAtMs": state.startedAtMs ?? 0,
                    "segmentSeconds": state.segmentSeconds,
                    "screenPermission": hasScreenRecordingPermission(),
                    "pid": getpid(),
                ]))
            case "shutdown":
                sendString(clientFd, jsonLine(["ok": true]))
                shutdown()
                exit(0)
            default:
                sendString(clientFd, jsonLine(["ok": false, "error": "unknown-command"]))
            }
        }
    }

    let runtime = RunLoop.current
    while true {
        runtime.run(mode: .default, before: Date.distantFuture)
    }
}

// MARK: - Client commands

func sendCommand(_ paths: MeetingPaths, _ command: String) {
    let fd = makeUnixSocket(path: paths.sockPath, listen: false)
    if fd < 0 {
        eprint("meeting_capture: daemon not reachable at \(paths.sockPath)")
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
    eprint("meeting_capture: --root <stellaHome> is required")
    exit(64)
}
let paths = MeetingPaths(root: args.stellaHome)

switch args.command {
case "daemon":
    runDaemon(paths: paths, defaultSegmentSeconds: args.segmentSeconds)
case "start":
    let id = args.sessionId ?? "-"
    sendCommand(paths, "start \(id) \(args.segmentSeconds)")
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
case "shutdown":
    sendCommand(paths, "shutdown")
default:
    eprint("meeting_capture: unknown command '\(args.command)'")
    eprint("Usage: meeting_capture {daemon|start|pause|resume|stop|status|ping|shutdown} --root <stellaHome>")
    exit(64)
}
