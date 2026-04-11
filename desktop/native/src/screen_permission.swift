import CoreGraphics
import Foundation

enum Action: String {
  case check
  case request
}

func currentStatus() -> Bool {
  if #available(macOS 11.0, *) {
    return CGPreflightScreenCaptureAccess()
  }

  return true
}

func requestStatus() -> Bool {
  if #available(macOS 11.0, *) {
    return CGRequestScreenCaptureAccess()
  }

  return true
}

let actionArg = CommandLine.arguments.dropFirst().first ?? Action.check.rawValue

guard let action = Action(rawValue: actionArg) else {
  FileHandle.standardError.write(
    Data("Unknown action: \(actionArg). Use 'check' or 'request'.\n".utf8),
  )
  exit(1)
}

let granted = switch action {
case .check:
  currentStatus()
case .request:
  requestStatus()
}

print(granted ? "granted" : "denied")
