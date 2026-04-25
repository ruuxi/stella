import AVFoundation
import Foundation
import FluidAudio

private let modelIdentifier = "parakeet-tdt-0.6b-v3-coreml"
private let minimumClipDuration: TimeInterval = 1.5

struct JsonMessage: Encodable {
  let ok: Bool
  let model: String
  let transcript: String?
  let error: String?
  var id: String? = nil
}

struct ServeRequest: Decodable {
  let id: String
  let audioPath: String
}

@main
struct ParakeetTranscriber {
  static func main() async {
    do {
      let args = Array(CommandLine.arguments.dropFirst())
      let command = args.first ?? "--help"
      var modelDirectoryOverride: URL?
      if let cacheRoot = parseValue("--cache-root", in: args), !cacheRoot.isEmpty {
        try FileManager.default.createDirectory(
          atPath: cacheRoot,
          withIntermediateDirectories: true
        )
        modelDirectoryOverride = URL(fileURLWithPath: cacheRoot, isDirectory: true)
          .appendingPathComponent("FluidAudio", isDirectory: true)
          .appendingPathComponent("Models", isDirectory: true)
          .appendingPathComponent("parakeet-tdt-0.6b-v3", isDirectory: true)
      }

      switch command {
      case "--probe":
        emit(JsonMessage(ok: true, model: modelIdentifier, transcript: nil, error: nil))
      case "--download":
        _ = try await loadManager(modelDirectory: modelDirectoryOverride)
        emit(JsonMessage(ok: true, model: modelIdentifier, transcript: nil, error: nil))
      case "--serve":
        let manager = try await loadManager(modelDirectory: modelDirectoryOverride)
        emit(JsonMessage(ok: true, model: modelIdentifier, transcript: nil, error: nil))
        await serve(manager: manager)
      case "--transcribe":
        guard let audioPath = parseValue("--audio", in: args) else {
          throw HelperError.missingArgument("--audio")
        }
        let audioURL = URL(fileURLWithPath: audioPath)
        let preparedURL = try prepareClipIfNeeded(audioURL)
        defer {
          if preparedURL != audioURL {
            try? FileManager.default.removeItem(at: preparedURL)
          }
        }
        let manager = try await loadManager(modelDirectory: modelDirectoryOverride)
        var decoderState = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
        let result = try await manager.transcribe(preparedURL, decoderState: &decoderState)
        emit(JsonMessage(
          ok: true,
          model: modelIdentifier,
          transcript: result.text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines),
          error: nil
        ))
      default:
        throw HelperError.usage
      }
    } catch {
      emit(JsonMessage(
        ok: false,
        model: modelIdentifier,
        transcript: nil,
        error: String(describing: error)
      ))
      Foundation.exit(1)
    }
  }

  private static func loadManager(modelDirectory: URL?) async throws -> AsrManager {
    let models = try await AsrModels.downloadAndLoad(to: modelDirectory, version: .v3)
    return AsrManager(config: .init(), models: models)
  }

  private static func serve(manager: AsrManager) async {
    while let line = readLine(strippingNewline: true) {
      guard let data = line.data(using: .utf8) else { continue }
      do {
        let request = try JSONDecoder().decode(ServeRequest.self, from: data)
        let audioURL = URL(fileURLWithPath: request.audioPath)
        let preparedURL = try prepareClipIfNeeded(audioURL)
        defer {
          if preparedURL != audioURL {
            try? FileManager.default.removeItem(at: preparedURL)
          }
        }
        var decoderState = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
        let result = try await manager.transcribe(preparedURL, decoderState: &decoderState)
        emit(JsonMessage(
          ok: true,
          model: modelIdentifier,
          transcript: result.text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines),
          error: nil,
          id: request.id
        ))
      } catch {
        let id = (try? JSONDecoder().decode(ServeRequest.self, from: data).id) ?? ""
        emit(JsonMessage(
          ok: false,
          model: modelIdentifier,
          transcript: nil,
          error: String(describing: error),
          id: id
        ))
      }
    }
  }

  private static func prepareClipIfNeeded(_ url: URL) throws -> URL {
    let inputFile = try AVAudioFile(forReading: url)
    let format = inputFile.processingFormat
    let duration = Double(inputFile.length) / format.sampleRate
    guard duration < minimumClipDuration else {
      return url
    }

    let minimumFrames = AVAudioFrameCount((minimumClipDuration * format.sampleRate).rounded(.up))
    let sourceCapacity = AVAudioFrameCount(max(1, min(inputFile.length, AVAudioFramePosition(AVAudioFrameCount.max))))
    guard
      let readBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: sourceCapacity),
      let paddedBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: minimumFrames)
    else {
      throw HelperError.audioBufferAllocationFailed
    }

    try inputFile.read(into: readBuffer)
    let framesRead = min(readBuffer.frameLength, minimumFrames)
    copyFrames(from: readBuffer, to: paddedBuffer, frames: framesRead)
    paddedBuffer.frameLength = minimumFrames

    let paddedURL = url
      .deletingLastPathComponent()
      .appendingPathComponent("\(url.deletingPathExtension().lastPathComponent)-parakeet-padded.wav")
    if FileManager.default.fileExists(atPath: paddedURL.path) {
      try FileManager.default.removeItem(at: paddedURL)
    }
    let outputFile = try AVAudioFile(forWriting: paddedURL, settings: inputFile.fileFormat.settings)
    try outputFile.write(from: paddedBuffer)
    return paddedURL
  }

  private static func copyFrames(
    from source: AVAudioPCMBuffer,
    to destination: AVAudioPCMBuffer,
    frames: AVAudioFrameCount
  ) {
    let channels = Int(source.format.channelCount)
    if let src = source.floatChannelData, let dst = destination.floatChannelData {
      for channel in 0..<channels {
        dst[channel].initialize(repeating: 0, count: Int(destination.frameCapacity))
        dst[channel].update(from: src[channel], count: Int(frames))
      }
      return
    }
    if let src = source.int16ChannelData, let dst = destination.int16ChannelData {
      for channel in 0..<channels {
        dst[channel].initialize(repeating: 0, count: Int(destination.frameCapacity))
        dst[channel].update(from: src[channel], count: Int(frames))
      }
      return
    }
    if let src = source.int32ChannelData, let dst = destination.int32ChannelData {
      for channel in 0..<channels {
        dst[channel].initialize(repeating: 0, count: Int(destination.frameCapacity))
        dst[channel].update(from: src[channel], count: Int(frames))
      }
    }
  }

  private static func parseValue(_ name: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else {
      return nil
    }
    return args[index + 1]
  }

  private static func emit(_ value: JsonMessage) {
    let data = try! JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
  }
}

enum HelperError: Error, CustomStringConvertible {
  case missingArgument(String)
  case audioBufferAllocationFailed
  case usage

  var description: String {
    switch self {
    case let .missingArgument(name):
      return "Missing required argument \(name)."
    case .audioBufferAllocationFailed:
      return "Unable to allocate an audio buffer."
    case .usage:
      return "Usage: parakeet_transcriber --probe | --download | --serve | --transcribe --audio <wav> [--cache-root <path>]"
    }
  }
}
