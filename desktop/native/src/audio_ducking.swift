import CoreAudio
import Foundation

private let systemOutputSessionId = "__stella_macos_system_output__"
private let mutedSnapshotToken = "muted:1"
private let unmutedSnapshotToken = "muted:0"

enum HelperError: Error {
  case invalidRequest(String)
  case coreAudio(String, OSStatus)
}

struct SnapshotEntry {
  let sessionId: String
  let sessionInstanceId: String
  let volume: Float32
}

struct Request {
  var action = ""
  var duckFactor: Float32 = 1.0
  var snapshot: [SnapshotEntry] = []
}

struct DeviceAudioState {
  let volume: Float32
  let muted: Bool
}

private func decodeBase64(_ value: String) throws -> String {
  guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    return ""
  }
  guard let data = Data(base64Encoded: value) else {
    throw HelperError.invalidRequest("Invalid base64 field")
  }
  return String(decoding: data, as: UTF8.self)
}

private func encodeBase64(_ value: String) -> String {
  Data(value.utf8).base64EncodedString()
}

private func parseRequest(from input: String) throws -> Request {
  var request = Request()

  for rawLine in input.split(whereSeparator: \.isNewline) {
    let line = String(rawLine)
    if line.isEmpty {
      continue
    }

    let parts = line.split(separator: "\t", omittingEmptySubsequences: false)
    guard !parts.isEmpty else { continue }

    switch String(parts[0]) {
    case "ACTION":
      guard parts.count >= 2 else {
        throw HelperError.invalidRequest("Missing ACTION value")
      }
      let action = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
      guard action == "duck" || action == "restore" else {
        throw HelperError.invalidRequest("Unsupported action: \(action)")
      }
      request.action = action

    case "DUCK_FACTOR":
      guard parts.count >= 2, let duckFactor = Float(String(parts[1])) else {
        throw HelperError.invalidRequest("Invalid DUCK_FACTOR value")
      }
      request.duckFactor = duckFactor

    case "SNAPSHOT":
      guard parts.count >= 4 else {
        throw HelperError.invalidRequest("Invalid SNAPSHOT line")
      }
      let sessionId = try decodeBase64(String(parts[1]))
      let sessionInstanceId = try decodeBase64(String(parts[2]))
      guard let volume = Float(String(parts[3])) else {
        throw HelperError.invalidRequest("Invalid SNAPSHOT volume")
      }
      request.snapshot.append(
        SnapshotEntry(
          sessionId: sessionId,
          sessionInstanceId: sessionInstanceId,
          volume: volume
        )
      )

    default:
      continue
    }
  }

  if request.action.isEmpty {
    throw HelperError.invalidRequest("Missing ACTION line")
  }

  return request
}

private func writeSuccess(snapshot: [SnapshotEntry]) {
  var lines = ["OK"]
  for entry in snapshot {
    lines.append(
      "SNAPSHOT\t\(encodeBase64(entry.sessionId))\t\(encodeBase64(entry.sessionInstanceId))\t\(String(format: "%.6f", entry.volume))"
    )
  }
  FileHandle.standardOutput.write(Data("\(lines.joined(separator: "\n"))\n".utf8))
}

private func writeError(_ message: String) -> Never {
  FileHandle.standardOutput.write(Data("ERROR\t\(message)\n".utf8))
  exit(1)
}

private func audioObjectError(_ message: String, _ status: OSStatus) -> HelperError {
  .coreAudio(message, status)
}

private func withAudioProperty<T>(
  objectId: AudioObjectID,
  address: inout AudioObjectPropertyAddress,
  valueType: T.Type
) throws -> T {
  var value = unsafeBitCast(0, to: T.self)
  var size = UInt32(MemoryLayout<T>.size)
  let status = AudioObjectGetPropertyData(objectId, &address, 0, nil, &size, &value)
  guard status == noErr else {
    throw audioObjectError("AudioObjectGetPropertyData failed", status)
  }
  return value
}

private func setAudioProperty<T>(
  objectId: AudioObjectID,
  address: inout AudioObjectPropertyAddress,
  value: inout T
) throws {
  var mutableValue = value
  let size = UInt32(MemoryLayout<T>.size)
  let status = AudioObjectSetPropertyData(objectId, &address, 0, nil, size, &mutableValue)
  guard status == noErr else {
    throw audioObjectError("AudioObjectSetPropertyData failed", status)
  }
}

private func defaultOutputDeviceId() throws -> AudioDeviceID {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  return try withAudioProperty(
    objectId: AudioObjectID(kAudioObjectSystemObject),
    address: &address,
    valueType: AudioDeviceID.self
  )
}

private func outputVolumeAddress(element: AudioObjectPropertyElement) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyVolumeScalar,
    mScope: kAudioDevicePropertyScopeOutput,
    mElement: element
  )
}

private func muteAddress(element: AudioObjectPropertyElement) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyMute,
    mScope: kAudioDevicePropertyScopeOutput,
    mElement: element
  )
}

private func getScalarVolume(deviceId: AudioDeviceID) throws -> Float32 {
  var masterAddress = outputVolumeAddress(element: kAudioObjectPropertyElementMain)
  if AudioObjectHasProperty(deviceId, &masterAddress) {
    return try withAudioProperty(objectId: deviceId, address: &masterAddress, valueType: Float32.self)
  }

  var leftAddress = outputVolumeAddress(element: 1)
  if AudioObjectHasProperty(deviceId, &leftAddress) {
    return try withAudioProperty(objectId: deviceId, address: &leftAddress, valueType: Float32.self)
  }

  throw HelperError.invalidRequest("Default output device does not expose a writable output volume")
}

private func setScalarVolume(deviceId: AudioDeviceID, volume: Float32) throws {
  let clamped = max(0.0, min(1.0, volume))

  var masterAddress = outputVolumeAddress(element: kAudioObjectPropertyElementMain)
  if AudioObjectHasProperty(deviceId, &masterAddress) {
    var value = clamped
    try setAudioProperty(objectId: deviceId, address: &masterAddress, value: &value)
    return
  }

  var wroteAnyChannel = false
  for element in [AudioObjectPropertyElement(1), AudioObjectPropertyElement(2)] {
    var address = outputVolumeAddress(element: element)
    if !AudioObjectHasProperty(deviceId, &address) {
      continue
    }
    var value = clamped
    try setAudioProperty(objectId: deviceId, address: &address, value: &value)
    wroteAnyChannel = true
  }

  if !wroteAnyChannel {
    throw HelperError.invalidRequest("Default output device does not expose a writable output volume")
  }
}

private func getMuteState(deviceId: AudioDeviceID) throws -> Bool {
  var masterAddress = muteAddress(element: kAudioObjectPropertyElementMain)
  if AudioObjectHasProperty(deviceId, &masterAddress) {
    let muted: UInt32 = try withAudioProperty(objectId: deviceId, address: &masterAddress, valueType: UInt32.self)
    return muted != 0
  }

  return false
}

private func setMuteState(deviceId: AudioDeviceID, muted: Bool) throws {
  var masterAddress = muteAddress(element: kAudioObjectPropertyElementMain)
  guard AudioObjectHasProperty(deviceId, &masterAddress) else {
    return
  }

  var value: UInt32 = muted ? 1 : 0
  try setAudioProperty(objectId: deviceId, address: &masterAddress, value: &value)
}

private func currentDeviceAudioState() throws -> DeviceAudioState {
  let deviceId = try defaultOutputDeviceId()
  return DeviceAudioState(
    volume: try getScalarVolume(deviceId: deviceId),
    muted: try getMuteState(deviceId: deviceId)
  )
}

private func applyDeviceAudioState(volume: Float32, muted: Bool) throws {
  let deviceId = try defaultOutputDeviceId()
  try setScalarVolume(deviceId: deviceId, volume: volume)
  try setMuteState(deviceId: deviceId, muted: muted)
}

private func handleDuck(_ request: Request) throws {
  let currentState = try currentDeviceAudioState()
  let snapshot = [
    SnapshotEntry(
      sessionId: systemOutputSessionId,
      sessionInstanceId: currentState.muted ? mutedSnapshotToken : unmutedSnapshotToken,
      volume: currentState.volume
    )
  ]

  if !currentState.muted {
    try applyDeviceAudioState(
      volume: currentState.volume * max(0.0, min(1.0, request.duckFactor)),
      muted: false
    )
  }

  writeSuccess(snapshot: snapshot)
}

private func handleRestore(_ request: Request) throws {
  guard let snapshot = request.snapshot.first(where: { $0.sessionId == systemOutputSessionId }) else {
    writeSuccess(snapshot: [])
    return
  }

  try applyDeviceAudioState(
    volume: snapshot.volume,
    muted: snapshot.sessionInstanceId == mutedSnapshotToken
  )
  writeSuccess(snapshot: [])
}

do {
  let inputData = FileHandle.standardInput.readDataToEndOfFile()
  let input = String(data: inputData, encoding: .utf8) ?? ""
  let request = try parseRequest(from: input)

  switch request.action {
  case "duck":
    try handleDuck(request)
  case "restore":
    try handleRestore(request)
  default:
    throw HelperError.invalidRequest("Unsupported action: \(request.action)")
  }
} catch let error as HelperError {
  switch error {
  case .invalidRequest(let message):
    writeError(message)
  case .coreAudio(let message, let status):
    writeError("\(message) (OSStatus \(status))")
  }
} catch {
  writeError(String(describing: error))
}
