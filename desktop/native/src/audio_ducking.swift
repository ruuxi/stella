import Foundation

enum HelperError: Error {
  case invalidRequest(String)
}

func parseAction(from input: String) throws -> String {
  for rawLine in input.split(whereSeparator: \.isNewline) {
    let line = String(rawLine)
    if line.isEmpty {
      continue
    }

    let parts = line.split(separator: "\t", omittingEmptySubsequences: false)
    if parts.count >= 2 && parts[0] == "ACTION" {
      let action = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
      if action == "duck" || action == "restore" {
        return action
      }
      throw HelperError.invalidRequest("Unsupported action: \(action)")
    }
  }

  throw HelperError.invalidRequest("Missing ACTION line")
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()
let input = String(data: inputData, encoding: .utf8) ?? ""

do {
  _ = try parseAction(from: input)
  FileHandle.standardOutput.write(Data("OK\n".utf8))
} catch {
  let message: String
  if case let HelperError.invalidRequest(detail) = error {
    message = detail
  } else {
    message = String(describing: error)
  }

  FileHandle.standardOutput.write(Data("ERROR\t\(message)\n".utf8))
  exit(1)
}
