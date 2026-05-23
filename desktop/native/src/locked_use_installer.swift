import Foundation

let pluginBundleName = "StellaLockedComputerUseAuthorizationPlugin.bundle"
let mechanismName = "StellaLockedComputerUseAuthorizationPlugin:allow"
let remoteRightName = "com.stella.app.LockedComputerUse.AuthorizationPlugin.remote"
let screensaverRightName = "system.login.screensaver"
let appSupportPath = "/Library/Application Support/StellaLockedComputerUseAuthorizationPlugin"
let installedPluginPath = "/Library/Security/SecurityAgentPlugins/\(pluginBundleName)"
let backupManifestPath = "\(appSupportPath)/latest-backup-manifest.plist"

struct InstallerError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

func fail(_ message: String) -> Never {
    fputs("ERROR: \(message)\n", stderr)
    exit(1)
}

func requireRoot(for action: String) throws {
    guard geteuid() == 0 else {
        throw InstallerError(message: "\(action) must run as root.")
    }
}

@discardableResult
func runProcess(
    _ executable: String,
    _ arguments: [String],
    stdin input: Data? = nil
) throws -> Data {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    if let input {
        let stdin = Pipe()
        process.standardInput = stdin
        try process.run()
        stdin.fileHandleForWriting.write(input)
        try stdin.fileHandleForWriting.close()
    } else {
        try process.run()
    }
    process.waitUntilExit()

    let out = stdout.fileHandleForReading.readDataToEndOfFile()
    let err = stderr.fileHandleForReading.readDataToEndOfFile()
    guard process.terminationStatus == 0 else {
        let stderrText = String(data: err, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let stdoutText = String(data: out, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let detail = [stderrText, stdoutText].compactMap { value in
            value?.isEmpty == false ? value : nil
        }.joined(separator: "\n")
        throw InstallerError(
            message: "\(executable) \(arguments.joined(separator: " ")) failed\(detail.isEmpty ? "" : ": \(detail)")"
        )
    }
    return out
}

func plistDictionary(from data: Data, label: String) throws -> [String: Any] {
    let value = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
    guard let dictionary = value as? [String: Any] else {
        throw InstallerError(message: "\(label) did not decode as a property-list dictionary.")
    }
    return dictionary
}

func plistData(_ dictionary: [String: Any]) throws -> Data {
    try PropertyListSerialization.data(
        fromPropertyList: dictionary,
        format: .xml,
        options: 0
    )
}

func readAuthorizationRight(_ right: String) throws -> [String: Any] {
    try plistDictionary(
        from: runProcess("/usr/bin/security", ["authorizationdb", "read", right]),
        label: right
    )
}

func writeAuthorizationRight(_ right: String, _ dictionary: [String: Any]) throws {
    try runProcess(
        "/usr/bin/security",
        ["authorizationdb", "write", right],
        stdin: plistData(dictionary)
    )
}

func removeAuthorizationRight(_ right: String) {
    _ = try? runProcess("/usr/bin/security", ["authorizationdb", "remove", right])
}

func sourcePluginPath(resourceDir: String) -> String {
    URL(fileURLWithPath: resourceDir)
        .appendingPathComponent(pluginBundleName)
        .path
}

func writeBackupIfNeeded(currentRight: [String: Any]) throws {
    let manager = FileManager.default
    if manager.fileExists(atPath: backupManifestPath) {
        return
    }

    let backupDir = "\(appSupportPath)/backups"
    try manager.createDirectory(
        atPath: backupDir,
        withIntermediateDirectories: true,
        attributes: nil
    )

    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    let stamp = formatter.string(from: Date())
    let backupPath = "\(backupDir)/system.login.screensaver.\(stamp).plist"
    try plistData(currentRight).write(to: URL(fileURLWithPath: backupPath), options: .atomic)

    let manifest: [String: Any] = [
        "screensaverRight": screensaverRightName,
        "backupPath": backupPath,
        "createdAt": ISO8601DateFormatter().string(from: Date()),
    ]
    try plistData(manifest).write(to: URL(fileURLWithPath: backupManifestPath), options: .atomic)
}

func readBackupManifest() throws -> [String: Any]? {
    guard FileManager.default.fileExists(atPath: backupManifestPath) else {
        return nil
    }
    return try plistDictionary(
        from: Data(contentsOf: URL(fileURLWithPath: backupManifestPath)),
        label: "latest backup manifest"
    )
}

func installPluginBundle(from resourceDir: String) throws {
    let source = sourcePluginPath(resourceDir: resourceDir)
    guard FileManager.default.fileExists(atPath: source) else {
        throw InstallerError(message: "missing bundled plug-in at \(source)")
    }

    let manager = FileManager.default
    try manager.createDirectory(
        atPath: URL(fileURLWithPath: installedPluginPath).deletingLastPathComponent().path,
        withIntermediateDirectories: true,
        attributes: nil
    )
    if manager.fileExists(atPath: installedPluginPath) {
        try manager.removeItem(atPath: installedPluginPath)
    }
    try manager.copyItem(atPath: source, toPath: installedPluginPath)
    try runProcess("/usr/sbin/chown", ["-R", "root:wheel", installedPluginPath])
    try runProcess("/bin/chmod", ["-R", "a+rX,go-w", installedPluginPath])
}

func remoteAuthorizationRight() -> [String: Any] {
    [
        "class": "evaluate-mechanisms",
        "comment": "Screen-unlock branch that asks Stella whether an active locked Computer Use authorization is pending.",
        "created": Date().timeIntervalSinceReferenceDate,
        "identifier": "com.apple.security",
        "mechanisms": [mechanismName],
        "modified": Date().timeIntervalSinceReferenceDate,
        "requirement": "identifier \"com.apple.security\" and anchor apple",
        "shared": true,
        "tries": 1,
        "version": 1,
    ]
}

func screensaverAuthorizationRight(from current: [String: Any]) -> [String: Any] {
    var next = current
    let existingRules = (current["rule"] as? [String] ?? [])
        .filter { $0 != remoteRightName }
    let fallbackRules = existingRules.isEmpty ? ["use-login-window-ui"] : existingRules
    next["class"] = "rule"
    next["comment"] = "The owner, an administrator, or Stella during an active locked Computer Use authorization can unlock the screensaver."
    next["k-of-n"] = 1
    next["modified"] = Date().timeIntervalSinceReferenceDate
    next["rule"] = [remoteRightName] + fallbackRules
    next["version"] = 1
    next.removeValue(forKey: "mechanisms")
    return next
}

func screensaverAuthorizationRightRemovingStella(
    from current: [String: Any],
    backup: [String: Any]?
) -> [String: Any] {
    guard let rules = current["rule"] as? [String],
          rules.contains(remoteRightName) else {
        return backup ?? current
    }

    let filteredRules = rules.filter { $0 != remoteRightName }
    guard !filteredRules.isEmpty else {
        return backup ?? [
            "class": "rule",
            "comment": "The owner or an administrator can unlock the screensaver.",
            "k-of-n": 1,
            "modified": Date().timeIntervalSinceReferenceDate,
            "rule": ["use-login-window-ui"],
            "version": 1,
        ]
    }

    var next = current
    next["rule"] = filteredRules
    next["modified"] = Date().timeIntervalSinceReferenceDate
    return next
}

func install(resourceDir: String) throws {
    try requireRoot(for: "install")
    let currentScreensaverRight = try readAuthorizationRight(screensaverRightName)
    try FileManager.default.createDirectory(
        atPath: appSupportPath,
        withIntermediateDirectories: true,
        attributes: nil
    )
    try writeBackupIfNeeded(currentRight: currentScreensaverRight)
    try installPluginBundle(from: resourceDir)
    try writeAuthorizationRight(remoteRightName, remoteAuthorizationRight())
    try writeAuthorizationRight(
        screensaverRightName,
        screensaverAuthorizationRight(from: currentScreensaverRight)
    )
    print("OK: installed")
}

func uninstall() throws {
    try requireRoot(for: "uninstall")
    var backup: [String: Any]?
    if let manifest = try readBackupManifest(),
       let backupPath = manifest["backupPath"] as? String,
       FileManager.default.fileExists(atPath: backupPath) {
        backup = try plistDictionary(
            from: Data(contentsOf: URL(fileURLWithPath: backupPath)),
            label: "recorded backup"
        )
    }
    if let current = try? readAuthorizationRight(screensaverRightName) {
        try writeAuthorizationRight(
            screensaverRightName,
            screensaverAuthorizationRightRemovingStella(from: current, backup: backup)
        )
    } else if let backup {
        try writeAuthorizationRight(screensaverRightName, backup)
    }
    removeAuthorizationRight(remoteRightName)
    if FileManager.default.fileExists(atPath: installedPluginPath) {
        try FileManager.default.removeItem(atPath: installedPluginPath)
    }
    try? FileManager.default.removeItem(atPath: appSupportPath)
    print("OK: uninstalled")
}

func status(resourceDir _: String) {
    let bundleInstalled = FileManager.default.fileExists(atPath: installedPluginPath)
    let remote = try? readAuthorizationRight(remoteRightName)
    let screensaver = try? readAuthorizationRight(screensaverRightName)
    let remoteOk = (remote?["mechanisms"] as? [String])?.contains(mechanismName) == true
    let screensaverOk = (screensaver?["rule"] as? [String])?.contains(remoteRightName) == true
    if bundleInstalled && remoteOk && screensaverOk {
        print("OK: installed")
    } else {
        print("OK: not-installed")
    }
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else {
    fail("usage: locked_use_installer install|uninstall|status RESOURCE_DIR")
}

let action = args[0]
let resourceDir = args[1]

do {
    switch action {
    case "install":
        try install(resourceDir: resourceDir)
    case "uninstall":
        try uninstall()
    case "status":
        status(resourceDir: resourceDir)
    default:
        fail("unknown action: \(action)")
    }
} catch {
    fail(error.localizedDescription)
}
