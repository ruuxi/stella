import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import OSAKit
import QuartzCore
import ScreenCaptureKit

struct Rect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

// Inline screenshot payload returned alongside snapshot/action results so the
// caller does not need a follow-up file read step. `path` is preserved for
// compatibility with consumers that still want to attach via filesystem; new
// consumers should prefer `data` (base64 PNG) for direct vision-input use.
struct Screenshot: Codable {
    let mimeType: String
    let data: String
    let path: String?
    let widthPx: Int?
    let heightPx: Int?
    let byteCount: Int
}

struct RefEntry: Codable {
    let ref: String
    let index: Int?
    let role: String
    let subrole: String?
    let primaryLabel: String?
    let title: String?
    let description: String?
    let value: String?
    let valueType: String?
    let settable: Bool?
    let details: String?
    let help: String?
    let identifier: String?
    let url: String?
    let windowTitle: String?
    let childPath: [Int]
    let ancestry: [String]
    let occurrence: Int
    let enabled: Bool?
    let focused: Bool?
    let selected: Bool?
    let frame: Rect?
    let actions: [String]
}

struct SnapshotNode: Codable {
    let index: Int?
    let ref: String?
    let role: String
    let subrole: String?
    let title: String?
    let description: String?
    let value: String?
    let valueType: String?
    let settable: Bool?
    let details: String?
    let help: String?
    let identifier: String?
    let url: String?
    let enabled: Bool?
    let focused: Bool?
    let selected: Bool?
    let frame: Rect?
    let actions: [String]
    let children: [SnapshotNode]
}

struct SnapshotDocument: Codable {
    let ok: Bool
    let appName: String
    let bundleId: String?
    let pid: Int32
    let windowTitle: String?
    let windowFrame: Rect?
    let windowId: UInt32?
    let nodeCount: Int
    let refCount: Int
    let refs: [String: RefEntry]
    let indices: [String: RefEntry]?
    let nodes: [SnapshotNode]
    let warnings: [String]
    let screenshotPath: String?
    let screenshot: Screenshot?
    let appInstructions: String?
    let capturedAt: String?
    let maxDepth: Int?
    let maxNodes: Int?
    let allWindows: Bool?
}

struct ActionPayload: Codable {
    let ok: Bool
    let action: String
    let ref: String?
    let message: String
    let matchedRef: String?
    let usedAction: String?
    let warnings: [String]
    let screenshotPath: String?
    let screenshot: Screenshot?
    let appInstructions: String?
    let snapshotText: String?
}

struct ListedAppPayload: Codable {
    let name: String
    let bundleId: String?
    let pid: Int32
    let activationPolicy: String
    let isActive: Bool
}

struct ListAppsPayload: Codable {
    let ok: Bool
    let apps: [ListedAppPayload]
    let warnings: [String]
}

struct ErrorPayload: Codable {
    let ok: Bool
    let error: String
    let warnings: [String]
    let screenshot: Screenshot?
    let screenshotPath: String?
}

struct AutomationDaemonRequest: Codable {
    let seq: Int
    let argv: [String]
    let env: [String: String]?
}

struct AutomationDaemonResponse: Codable {
    let seq: Int
    let status: Int32
    let stdout: String
    let stderr: String
}

struct CommandExecutionResult {
    let status: Int32
    let stdout: String
    let stderr: String
}

struct SnapshotOptions {
    let pid: Int32?
    let appName: String?
    let bundleId: String?
    let maxDepth: Int
    let maxNodes: Int
    let statePath: String
    let screenshotPath: String?
    let inlineScreenshot: Bool
    let allWindows: Bool
}

struct ActionOptions {
    let statePath: String
    let coordinateFallback: Bool
    let allowHid: Bool
    let captureScreenshot: Bool
    // Whether to bring the target app frontmost before dispatching this
    // action. Default is false: stella-computer drives apps via Accessibility
    // in the background and the user's active window must not be disturbed.
    // Opt in with --raise (or STELLA_COMPUTER_RAISE=1) only when the action
    // genuinely requires the app to be focused (e.g. global HID coordinate
    // clicks). The legacy --no-raise flag is accepted as a no-op.
    let raise: Bool
    let inlineScreenshot: Bool
    let showOverlay: Bool
}

struct AppTarget {
    let app: NSRunningApplication
    let axApp: AXUIElement
}

struct OverlayCursorState: Codable {
    let x: Double
    let y: Double
}

struct NodeDetails {
    let role: String
    let subrole: String?
    let title: String?
    let description: String?
    let value: String?
    let valueType: String?
    let settable: Bool?
    let details: String?
    let help: String?
    let identifier: String?
    let url: String?
    let enabled: Bool?
    let focused: Bool?
    let selected: Bool?
    let frame: Rect?
    let actions: [String]
}

struct CandidateNode {
    let element: AXUIElement
    let role: String
    let subrole: String?
    let primaryLabel: String?
    let title: String?
    let description: String?
    let value: String?
    let identifier: String?
    let url: String?
    let windowTitle: String?
    let childPath: [Int]
    let ancestry: [String]
    let occurrence: Int
    let enabled: Bool?
    let focused: Bool?
    let selected: Bool?
    let frame: Rect?
    let actions: [String]
}

struct RankedCandidate {
    let candidate: CandidateNode
    let score: Int
}

struct ResolvedCandidate {
    let candidate: CandidateNode
    let score: Int
    let warnings: [String]
}

struct PreparedTextMatch {
    let normalized: String
    let tokens: Set<String>
}

struct PreparedRefEntry {
    let role: String
    let subrole: PreparedTextMatch
    let primaryLabel: PreparedTextMatch
    let title: PreparedTextMatch
    let description: PreparedTextMatch
    let value: PreparedTextMatch
    let identifier: PreparedTextMatch
    let url: PreparedTextMatch
    let windowTitle: PreparedTextMatch
    let childPath: [Int]
    let ancestry: [String]
    let occurrence: Int
    let enabled: Bool?
    let focused: Bool?
    let selected: Bool?
    let frame: Rect?
    let actionsSet: Set<String>
}

struct PreparedCandidateNode {
    let candidate: CandidateNode
    let subrole: PreparedTextMatch
    let primaryLabel: PreparedTextMatch
    let title: PreparedTextMatch
    let description: PreparedTextMatch
    let value: PreparedTextMatch
    let identifier: PreparedTextMatch
    let url: PreparedTextMatch
    let windowTitle: PreparedTextMatch
    let actionsSet: Set<String>
}

struct DesktopAutomationFailure: Error {
    let message: String
    let warnings: [String]
    let screenshotPath: String?
    let screenshot: Screenshot?
}

let interactiveRoles: Set<String> = [
    "AXBrowser",
    "AXCell",
    "AXButton",
    "AXCheckBox",
    "AXComboBox",
    "AXDisclosureTriangle",
    "AXIncrementor",
    "AXLink",
    "AXList",
    "AXMenuButton",
    "AXMenuBarItem",
    "AXMenuItem",
    "AXOutline",
    "AXPopUpButton",
    "AXRadioButton",
    "AXRow",
    "AXScrollArea",
    "AXSearchField",
    "AXSecureTextField",
    "AXSlider",
    "AXSwitch",
    "AXTable",
    "AXTabButton",
    "AXTextArea",
    "AXTextField",
    "AXWebArea",
]

let valueBearingRoles: Set<String> = [
    "AXCell",
    "AXCheckBox",
    "AXComboBox",
    "AXPopUpButton",
    "AXRadioButton",
    "AXSearchField",
    "AXSecureTextField",
    "AXSlider",
    "AXStaticText",
    "AXSwitch",
    "AXTextArea",
    "AXTextField",
]

let selectableRoles: Set<String> = [
    "AXCell",
    "AXCheckBox",
    "AXList",
    "AXMenuItem",
    "AXOutline",
    "AXRadioButton",
    "AXRow",
    "AXTabButton",
    "AXTable",
]

let preferredActionNames: [String] = [
    kAXPressAction as String,
    "AXConfirm",
    "AXPick",
    "AXOpen",
    "AXShowMenu",
    "AXRaise",
]

let roleSpecificArrayChildAttributes: [String: [String]] = [
    "AXBrowser": ["AXVisibleColumns", "AXColumns"],
    "AXList": ["AXVisibleRows", "AXRows", "AXSelectedRows"],
    "AXOutline": ["AXVisibleRows", "AXRows", "AXSelectedRows"],
    "AXTable": ["AXVisibleRows", "AXRows", "AXSelectedRows", "AXColumns"],
    "AXTabGroup": ["AXTabs", "AXSelectedChildren"],
    "AXWindow": ["AXSheets"],
]

let roleSpecificSingleChildAttributes: [String: [String]] = [
    "AXScrollArea": ["AXContents"],
    "AXWindow": ["AXToolbar", "AXSheet"],
]

// Roles where we'll fall back to `kAXChildren` when no role-specific child
// attribute produced descendants. Without an entry here, `axChildren`
// returns the empty array even if the underlying element has children —
// that's deliberate for opaque containers we don't want to walk into.
//
// We MUST descend into AXGroup, AXWebArea, AXScrollArea, AXSplitGroup,
// and AXGenericElement because that's how CEF/Electron/WebKit hosts
// expose their entire DOM under the parent app's window:
//
//   AXWindow
//     AXGroup (URL: https://...)        ← the whole webview
//       AXGroup → AXGroup → AXButton ...  ← actual app UI
//
// Without these, Spotify, Discord, Slack, VS Code, Notion, and any
// app with a WKWebView/Chromium subtree comes back as an empty shell.
let safeFallbackChildRoles: Set<String> = [
    "AXApplication",
    "AXBrowser",
    "AXGenericElement",
    "AXGroup",
    "AXList",
    "AXMenu",
    "AXMenuBar",
    // Menu bar items expose their AXMenu child via kAXChildren even before
    // the menu is opened, but only if the walker actually falls through to
    // kAXChildren. That's how we surface Spotify > Playback > Play (and the
    // equivalent for any other app) so background AXPress targeting works
    // without raising the window.
    "AXMenuBarItem",
    "AXMenuItem",
    "AXMenuButton",
    "AXOutline",
    "AXRow",
    "AXScrollArea",
    "AXSheet",
    "AXSplitGroup",
    "AXTable",
    "AXTabGroup",
    "AXToolbar",
    "AXWebArea",
    "AXWindow",
]

let namedKeyCodes: [String: CGKeyCode] = [
    "return": 36,
    "enter": 36,
    "kp_enter": 76,
    "tab": 48,
    "space": 49,
    "escape": 53,
    "esc": 53,
    "delete": 51,
    "backspace": 51,
    "forwarddelete": 117,
    "kp_delete": 71,
    "up": 126,
    "down": 125,
    "left": 123,
    "right": 124,
    "home": 115,
    "end": 119,
    "pageup": 116,
    "page_up": 116,
    "pagedown": 121,
    "page_down": 121,
    "f1": 122,
    "f2": 120,
    "f3": 99,
    "f4": 118,
    "f5": 96,
    "f6": 97,
    "f7": 98,
    "f8": 100,
    "f9": 101,
    "f10": 109,
    "f11": 103,
    "f12": 111,
    "f13": 105,
    "f14": 107,
    "f15": 113,
    "f16": 106,
    "f17": 64,
    "f18": 79,
    "f19": 80,
    "f20": 90,
    "kp_0": 82,
    "kp_1": 83,
    "kp_2": 84,
    "kp_3": 85,
    "kp_4": 86,
    "kp_5": 87,
    "kp_6": 88,
    "kp_7": 89,
    "kp_8": 91,
    "kp_9": 92,
    "kp_decimal": 65,
    "kp_separator": 65,
    "kp_multiply": 67,
    "kp_add": 69,
    "kp_subtract": 78,
    "kp_divide": 75,
    "kp_equal": 81,
    "kp_clear": 71,
    "capslock": 57,
    "caps_lock": 57,
    "help": 114,
    "volumeup": 72,
    "volumedown": 73,
    "mute": 74,
]

let letterKeyCodes: [String: CGKeyCode] = [
    "a": 0,
    "b": 11,
    "c": 8,
    "d": 2,
    "e": 14,
    "f": 3,
    "g": 5,
    "h": 4,
    "i": 34,
    "j": 38,
    "k": 40,
    "l": 37,
    "m": 46,
    "n": 45,
    "o": 31,
    "p": 35,
    "q": 12,
    "r": 15,
    "s": 1,
    "t": 17,
    "u": 32,
    "v": 9,
    "w": 13,
    "x": 7,
    "y": 16,
    "z": 6,
]

let digitKeyCodes: [String: CGKeyCode] = [
    "0": 29,
    "1": 18,
    "2": 19,
    "3": 20,
    "4": 21,
    "5": 23,
    "6": 22,
    "7": 26,
    "8": 28,
    "9": 25,
]

func traceEnabled() -> Bool {
    ProcessInfo.processInfo.environment["STELLA_COMPUTER_TRACE"] == "1"
}

func trace(_ message: @autoclosure () -> String) {
    guard traceEnabled() else { return }
    fputs("[trace] \(message())\n", stderr)
}

let daemonScopedEnvironmentKeys: [String] = [
    "STELLA_COMPUTER_ALLOW_HID",
    "STELLA_COMPUTER_ALWAYS_SIMULATE_CLICK",
    "STELLA_COMPUTER_ALWAYS_SIMULATE_INPUT",
    "STELLA_COMPUTER_APP_INSTRUCTIONS_DIR",
    "STELLA_COMPUTER_FORBIDDEN_BUNDLES",
    "STELLA_COMPUTER_FORBIDDEN_URL_SUBSTRINGS",
    "STELLA_COMPUTER_MIN_CONFIDENCE",
    "STELLA_COMPUTER_MIN_GAP",
    "STELLA_COMPUTER_NO_INLINE_SCREENSHOT",
    "STELLA_COMPUTER_NO_OVERLAY",
    "STELLA_COMPUTER_NO_RAISE",
    "STELLA_COMPUTER_RAISE",
    "STELLA_COMPUTER_SESSION",
    "STELLA_COMPUTER_TRACE",
]

// Hardcoded forbidden bundle identifiers. The agent must never automate these
// to prevent self-takeover or sensitive-app interference.
let baseForbiddenBundleIdentifiers: Set<String> = [
    // Stella's own surfaces (defense-in-depth).
    "com.stella.desktop",
    "com.stella.app",
    "com.stella.runtime",
    "com.openai.codex",
    // System security / privacy surfaces.
    "com.apple.systempreferences",
    "com.apple.SystemSettings",
    "com.apple.keychainaccess",
    "com.apple.security.Keychain-Access",
    "com.apple.SecurityAgent",
    "com.apple.LocalAuthentication.UIAgent",
    // Common password managers.
    "com.1password.1password",
    "com.1password.1password7",
    "com.agilebits.onepassword7",
    "com.lastpass.lastpassmacdesktop",
    "com.bitwarden.desktop",
    "com.dashlane.dashlane",
]

func forbiddenBundleIdentifiers() -> Set<String> {
    var set = baseForbiddenBundleIdentifiers
    if let extra = ProcessInfo.processInfo.environment["STELLA_COMPUTER_FORBIDDEN_BUNDLES"] {
        for piece in extra.split(separator: ",") {
            let trimmed = piece.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty {
                set.insert(trimmed)
            }
        }
    }
    return set
}

// Per-app operator manuals that ship with the binary. Keyed by bundle id.
// When `get_app_state` resolves to one of these targets we surface the
// matching guidance to the agent so it doesn't have to rediscover app
// quirks each session. This mirrors Codex Computer Use's bundled
// `AppInstructions/*.md` resources.
let bundledAppInstructions: [String: String] = [
    "com.apple.iCal": """
        # Calendar Computer Use

        - Switch views via the toolbar segmented control (Day/Week/Month/Year).
        - Create events by double-clicking an empty time slot, then editing the inline popover.
          Use `set-value` on the title field; `press tab` to advance to the date/time fields.
        - Avoid relying on All-Day-toggle keyboard shortcuts; they are different per locale.
        - For recurring events open the inline popover, click "None" next to "repeat", and pick.
        """,
    "com.apple.MobileSMS": """
        # Messages Computer Use

        - Conversations live under the sidebar table; refs in that list are the threads.
        - To send a message, focus the message text area (it's an `AXTextArea`, settable string),
          then `press return`. Do NOT paste multi-line content as a single keystroke; type-text
          chunks at 200 chars and Messages may flatten the rest.
        - Attachments via `drag-element --type file` work for images/files in /tmp.
        - Never act on conversations whose name contains 2-factor codes, security alerts, or
          banking institutions; surface the request to the user instead.
        """,
    "com.apple.Notes": """
        # Notes Computer Use

        - The note body is an `AXTextArea` that supports rich text.
        - For headings: focus body, type text, then `press cmd+shift+t`. For bullets: `cmd+shift+7`.
          List indent: tab / shift+tab inside a list item.
        - Switching folders: click the folder ref in the sidebar; the body re-renders, so refs
          in the body change. Take a fresh snapshot after switching.
        """,
    "com.apple.finder": """
        # Finder Computer Use

        - Sidebar entries are `AXRow` rows under an `AXOutline`; click to navigate. List-view
          rows expose a settable `AXTextField` for filenames — DO NOT call `set-value` on it
          unless the user explicitly asked to rename a file.
        - Splitter: `set-value` works on the `AXSplitter` (numeric position).
        - Search: `press cmd+f` then `type` into the search field; Finder switches to a
          "Searching" window with refreshed refs.
        - Drag-to-move files: prefer `drag-element --type file` from a row ref to a destination
          folder ref. The raw `drag` command will not produce a real Finder file move.
        """,
    "com.spotify.client": """
        ## Spotify Computer Use

        ### Playing media

        The Spotify app doesn't immediately update after requesting playback, so the result from a
        click might indicate paused media or outdated media. Instead of acting again, first: run
        `get-state` to confirm it didn't take. You may be pleasantly surprised. Do not sleep any
        time, it should be updated by the time you notice and request another `get-state`.

        ### Searching

        Be sure the search field is focused before pressing return to search. If you press return
        without the search field focused, it may affect playback inadvertently.

        ### General Navigation

        This app is not fully local state. That means you must sometimes wait for network to give
        you a response. When searching, that means it might say "no results" momentarily. Err on
        running `get-state` again before changing course.
        """,
    "com.apple.MobileSafari": """
        # Safari Computer Use

        - Tab strip is the `AXTabGroup`; addressbar is an `AXTextField` with title "Address".
        - To navigate: click the address bar, `set-value` the URL, then `press return`.
        - Page content is OOP and may not surface in the AX tree; if you need DOM-level access,
          prefer stella-browser.
        """,
    "com.apple.Safari": """
        # Safari Computer Use

        - Tab strip is the `AXTabGroup`; addressbar is an `AXTextField` with title "Address".
        - To navigate: click the address bar, `set-value` the URL, then `press return`.
        - Page content is OOP and may not surface in the AX tree; if you need DOM-level access,
          prefer stella-browser.
        """,
]

func bundleAppInstructions(for bundleId: String?) -> String? {
    guard let bundleId, !bundleId.isEmpty else { return nil }
    if let exact = bundledAppInstructions[bundleId] {
        return exact
    }
    // Allow STELLA_COMPUTER_APP_INSTRUCTIONS_DIR to host extra .md files
    // keyed by bundle id (e.g. "com.example.app.md"). This is how we let
    // users add per-app manuals without rebuilding the binary.
    if let extraDir = ProcessInfo.processInfo.environment["STELLA_COMPUTER_APP_INSTRUCTIONS_DIR"] {
        let url = URL(fileURLWithPath: extraDir)
            .appendingPathComponent("\(bundleId).md")
        if let data = try? String(contentsOf: url, encoding: .utf8), !data.isEmpty {
            return data
        }
    }
    return nil
}

// URL substrings that should never be operated on. Hosts of internet banking,
// auth surfaces, etc. Substring match is intentional (catches subdomains).
let baseForbiddenUrlSubstrings: [String] = [
    "accounts.google.com/signin",
    "appleid.apple.com",
    "login.microsoftonline.com",
    "secure.bankofamerica.com",
    "wellsfargo.com/online-banking",
    "chase.com/digital",
    "paypal.com/signin",
    "stripe.com/login",
    "github.com/login",
    "auth0.com/login",
    "okta.com/login",
]

func forbiddenUrlSubstrings() -> [String] {
    var list = baseForbiddenUrlSubstrings
    if let extra = ProcessInfo.processInfo.environment["STELLA_COMPUTER_FORBIDDEN_URL_SUBSTRINGS"] {
        for piece in extra.split(separator: ",") {
            let trimmed = piece.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty {
                list.append(trimmed)
            }
        }
    }
    return list
}

let axMessagingTimeoutSeconds: Float = 0.5
let axRetryAttempts = 2
let axRetrySleepUSec: useconds_t = 30_000

// Bundle identifiers known to host UI in helper child processes via
// Chromium / WebKit frame trees. When AX queries against them fail with
// `cannotComplete` we treat that as an Out-Of-Process element rather than
// a hard failure.
let oopHostingBundleIdentifierPrefixes: [String] = [
    "com.google.Chrome",
    "com.brave.Browser",
    "company.thebrowser.Browser",
    "com.microsoft.edgemac",
    "com.apple.Safari",
    "com.operasoftware.Opera",
    "com.vivaldi.Vivaldi",
    "com.todesktop.",
    "com.electron",
    "com.github.Electron",
]

func encodedJson<T: Encodable>(_ payload: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try encoder.encode(payload)
    return String(data: data, encoding: .utf8) ?? "{\"ok\":false,\"error\":\"failed to encode response\"}"
}

func commandResult<T: Encodable>(
    _ payload: T,
    code: Int32 = 0,
    stderr: String = ""
) -> CommandExecutionResult {
    let stdout: String
    do {
        stdout = try encodedJson(payload)
    } catch {
        stdout = "{\"ok\":false,\"error\":\"failed to encode response\"}"
    }
    return CommandExecutionResult(status: code, stdout: stdout, stderr: stderr)
}

func emitCommandResult(_ result: CommandExecutionResult) -> Never {
    print(result.stdout)
    if !result.stderr.isEmpty {
        fputs("\(result.stderr)\n", stderr)
    }
    exit(result.status)
}

func exitWithJson<T: Encodable>(_ payload: T, code: Int32 = 0) -> Never {
    emitCommandResult(commandResult(payload, code: code))
}

func normalized(_ value: String?) -> String {
    guard let value else { return "" }
    return value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
}

func trimmed(_ value: String?) -> String? {
    guard let value else { return nil }
    let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return result.isEmpty ? nil : result
}

func truncateValue(_ value: String?, limit: Int = 160) -> String? {
    guard let value = trimmed(value) else { return nil }
    if value.count <= limit {
        return value
    }
    let index = value.index(value.startIndex, offsetBy: limit)
    return String(value[..<index]) + "..."
}

func tokenSet(fromNormalized value: String) -> Set<String> {
    guard !value.isEmpty else { return [] }
    let separators = CharacterSet.alphanumerics.inverted
    let tokens = value
        .components(separatedBy: separators)
        .filter { !$0.isEmpty }
    return Set(tokens)
}

func normalizedTokens(_ value: String?) -> Set<String> {
    tokenSet(fromNormalized: normalized(value))
}

func preparedText(_ value: String?) -> PreparedTextMatch {
    let normalizedValue = normalized(value)
    return PreparedTextMatch(
        normalized: normalizedValue,
        tokens: tokenSet(fromNormalized: normalizedValue)
    )
}

func tokenSimilarityScore(_ lhs: PreparedTextMatch, _ rhs: PreparedTextMatch, maxScore: Int) -> Int {
    guard !lhs.tokens.isEmpty, !rhs.tokens.isEmpty else { return 0 }
    let overlap = lhs.tokens.intersection(rhs.tokens).count
    guard overlap > 0 else { return 0 }
    let union = lhs.tokens.union(rhs.tokens).count
    let similarity = Double(overlap) / Double(max(union, 1))
    return Int((Double(maxScore) * similarity).rounded())
}

func tokenSimilarityScore(_ lhs: String?, _ rhs: String?, maxScore: Int) -> Int {
    let lhsTokens = normalizedTokens(lhs)
    let rhsTokens = normalizedTokens(rhs)
    guard !lhsTokens.isEmpty, !rhsTokens.isEmpty else { return 0 }
    let overlap = lhsTokens.intersection(rhsTokens).count
    guard overlap > 0 else { return 0 }
    let union = lhsTokens.union(rhsTokens).count
    let similarity = Double(overlap) / Double(max(union, 1))
    return Int((Double(maxScore) * similarity).rounded())
}

func containsNormalizedString(_ lhs: PreparedTextMatch, _ rhs: PreparedTextMatch) -> Bool {
    guard !lhs.normalized.isEmpty, !rhs.normalized.isEmpty else { return false }
    return lhs.normalized.contains(rhs.normalized) || rhs.normalized.contains(lhs.normalized)
}

func containsNormalizedString(_ lhs: String?, _ rhs: String?) -> Bool {
    let left = normalized(lhs)
    let right = normalized(rhs)
    guard !left.isEmpty, !right.isEmpty else { return false }
    return left.contains(right) || right.contains(left)
}

func derivedScreenshotPath(for statePath: String) -> String {
    let url = URL(fileURLWithPath: statePath)
    let stem = url.deletingPathExtension().path
    return stem + ".png"
}

func derivedFailureScreenshotPath(for statePath: String) -> String {
    let url = URL(fileURLWithPath: statePath)
    let stem = url.deletingPathExtension().path
    return stem + "-failure.png"
}

func isoTimestamp() -> String {
    ISO8601DateFormatter().string(from: Date())
}

func rectFrom(position: CGPoint?, size: CGSize?) -> Rect? {
    guard let position, let size else { return nil }
    return Rect(
        x: Double(position.x),
        y: Double(position.y),
        width: Double(size.width),
        height: Double(size.height)
    )
}

func rectToCGRect(_ rect: Rect) -> CGRect {
    CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
}

func resolveOnScreenWindowID(
    pid: Int32,
    expectedTitle: String?,
    expectedFrame: Rect?
) -> CGWindowID? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }

    let expectedTitleNormalized = normalized(expectedTitle)
    let expectedCGRect = expectedFrame.map(rectToCGRect)
    var best: (windowID: CGWindowID, score: CGFloat)?

    for entry in raw {
        guard let entryPid = (entry[kCGWindowOwnerPID as String] as? Int).map(Int32.init),
              entryPid == pid,
              let windowID = entry[kCGWindowNumber as String] as? CGWindowID,
              let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat] else {
            continue
        }

        let layer = entry[kCGWindowLayer as String] as? Int ?? 0
        if layer < 0 || layer > 3 { continue }

        let frame = CGRect(
            x: bounds["X"] ?? 0,
            y: bounds["Y"] ?? 0,
            width: bounds["Width"] ?? 0,
            height: bounds["Height"] ?? 0
        )
        if frame.width <= 0 || frame.height <= 0 { continue }

        var score: CGFloat
        if let expectedCGRect {
            let intersection = frame.intersection(expectedCGRect)
            let overlapArea = intersection.isNull ? 0 : intersection.width * intersection.height
            if overlapArea <= 0 { continue }
            score = overlapArea
        } else {
            score = frame.width * frame.height
        }

        let entryTitleNormalized = normalized(entry[kCGWindowName as String] as? String)
        if !expectedTitleNormalized.isEmpty,
           !entryTitleNormalized.isEmpty,
           entryTitleNormalized == expectedTitleNormalized {
            score *= 4
        }

        if best == nil || score > best!.score {
            best = (windowID: windowID, score: score)
        }
    }

    return best?.windowID
}

func frameCenter(_ rect: Rect) -> CGPoint {
    CGPoint(
        x: rect.x + (rect.width / 2.0),
        y: rect.y + (rect.height / 2.0)
    )
}

// Tracks per-process notes (e.g. OOP element warnings) for the current
// command so commands can surface diagnostics in their warnings array
// without threading state through every helper.
final class AxDiagnostics {
    static let shared = AxDiagnostics()
    private(set) var oopHits = 0
    private(set) var transientRetries = 0

    func recordOOP() { oopHits += 1 }
    func recordTransientRetry() { transientRetries += 1 }
    func reset() {
        oopHits = 0
        transientRetries = 0
    }

    func warnings() -> [String] {
        var out: [String] = []
        if oopHits > 0 {
            out.append("Some elements live in helper processes (OOP) and could not be inspected directly (\(oopHits) attribute reads).")
        }
        return out
    }
}

@discardableResult
func axAttributeValueRaw(
    _ element: AXUIElement,
    _ attribute: String
) -> (AnyObject?, AXError) {
    trace("attr:start id=\(elementHash(element)) name=\(attribute)")
    var value: AnyObject?
    var attempt = 0
    var lastResult: AXError = .success
    while attempt <= axRetryAttempts {
        let result = AXUIElementCopyAttributeValue(
            element,
            attribute as CFString,
            &value
        )
        lastResult = result
        if result == .success {
            trace("attr:end id=\(elementHash(element)) name=\(attribute) result=ok")
            return (value, .success)
        }
        // Only retry on transient cannotComplete; everything else is final
        // (e.g. attributeUnsupported, noValue, invalidUIElement).
        if result != .cannotComplete {
            trace("attr:end id=\(elementHash(element)) name=\(attribute) result=\(result.rawValue)")
            if result == .noValue {
                return (nil, .noValue)
            }
            if result == .cannotComplete {
                AxDiagnostics.shared.recordOOP()
            }
            return (nil, result)
        }
        attempt += 1
        if attempt > axRetryAttempts {
            break
        }
        AxDiagnostics.shared.recordTransientRetry()
        usleep(axRetrySleepUSec)
    }
    trace("attr:end id=\(elementHash(element)) name=\(attribute) result=cannotComplete after \(attempt) retries")
    AxDiagnostics.shared.recordOOP()
    return (nil, lastResult)
}

func axAttributeValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    let (value, _) = axAttributeValueRaw(element, attribute)
    return value
}

// Batched read using AXUIElementCopyMultipleAttributeValues. Returns a
// dictionary keyed by attribute name; missing or error values are omitted.
// `.stopOnError` is intentionally NOT set so that one bad attribute does not
// poison the rest of the read.
func axBatchedAttributes(
    _ element: AXUIElement,
    _ attributes: [String]
) -> [String: AnyObject] {
    guard !attributes.isEmpty else { return [:] }
    let attrArray = attributes as CFArray
    var values: CFArray?
    let result = AXUIElementCopyMultipleAttributeValues(
        element,
        attrArray,
        AXCopyMultipleAttributeOptions(rawValue: 0),
        &values
    )
    if result != .success {
        if result == .cannotComplete {
            AxDiagnostics.shared.recordOOP()
        }
        return [:]
    }
    guard let values, CFArrayGetCount(values) == attributes.count else {
        return [:]
    }
    var dict: [String: AnyObject] = [:]
    for index in 0..<CFArrayGetCount(values) {
        let raw = CFArrayGetValueAtIndex(values, index)
        guard let raw else { continue }
        let value = unsafeBitCast(raw, to: AnyObject.self)
        // CFArray entries that came back as AXError get represented as a
        // CFNumber wrapping the AXError value; skip those.
        if CFGetTypeID(value) == CFNumberGetTypeID() {
            // Heuristic: CFNumberRef of AXError code; skip if matches.
            // We can't disambiguate a real number-valued attribute from an
            // error sentinel, so only skip when value == an AXError raw.
            // In practice, attributes we batch (role/title/value/...) are not
            // numeric, so this is safe for our usage.
            continue
        }
        dict[attributes[index]] = value
    }
    return dict
}

func axStringValue(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let rawValue = axAttributeValue(element, attribute) else {
        return nil
    }
    if let stringValue = rawValue as? String {
        return trimmed(stringValue)
    }
    if let numberValue = rawValue as? NSNumber {
        return numberValue.stringValue
    }
    return nil
}

func axBoolValue(_ element: AXUIElement, _ attribute: String) -> Bool? {
    guard let rawValue = axAttributeValue(element, attribute) else {
        return nil
    }
    if let boolValue = rawValue as? Bool {
        return boolValue
    }
    if let numberValue = rawValue as? NSNumber {
        return numberValue.boolValue
    }
    return nil
}

func axAttributeSettable(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var settable = DarwinBoolean(false)
    let result = AXUIElementIsAttributeSettable(
        element,
        attribute as CFString,
        &settable
    )
    guard result == .success else {
        if result == .cannotComplete {
            AxDiagnostics.shared.recordOOP()
        }
        return nil
    }
    return settable.boolValue
}

func numericValueTypeName(_ number: NSNumber) -> String {
    if CFGetTypeID(number) == CFBooleanGetTypeID() {
        return "boolean"
    }
    let cfType = CFNumberGetType(number)
    switch cfType {
    case .float32Type, .float64Type, .floatType, .doubleType, .cgFloatType:
        return "float"
    default:
        return "integer"
    }
}

func axPointValue(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    guard let rawValue = axAttributeValue(element, attribute) else { return nil }
    guard CFGetTypeID(rawValue) == AXValueGetTypeID() else { return nil }
    let axValue = rawValue as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

func axSizeValue(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    guard let rawValue = axAttributeValue(element, attribute) else { return nil }
    guard CFGetTypeID(rawValue) == AXValueGetTypeID() else { return nil }
    let axValue = rawValue as! AXValue
    guard AXValueGetType(axValue) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

func axElementValue(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    coerceElement(axAttributeValue(element, attribute))
}

func axElementArrayValue(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
    let results = coerceElementArray(axAttributeValue(element, attribute))
    trace("attr:array id=\(elementHash(element)) name=\(attribute) count=\(results.count)")
    return results
}

func elementHash(_ element: AXUIElement) -> Int {
    Int(truncatingIfNeeded: CFHash(element))
}

func appendUniqueElement(
    _ candidate: AXUIElement?,
    into elements: inout [AXUIElement],
    excluding parent: AXUIElement? = nil
) {
    guard let candidate else { return }
    if let parent, CFEqual(candidate, parent) {
        return
    }
    if elements.contains(where: { CFEqual($0, candidate) }) {
        return
    }
    elements.append(candidate)
}

func appendUniqueElements(
    _ candidates: [AXUIElement],
    into elements: inout [AXUIElement],
    excluding parent: AXUIElement? = nil
) {
    for candidate in candidates {
        appendUniqueElement(candidate, into: &elements, excluding: parent)
    }
}

func axChildren(_ element: AXUIElement, role: String? = nil) -> [AXUIElement] {
    var results: [AXUIElement] = []
    var seenHashes: Set<Int> = []

    func appendResult(_ candidate: AXUIElement?) {
        guard let candidate else { return }
        if CFEqual(candidate, element) {
            return
        }
        let candidateHash = elementHash(candidate)
        if seenHashes.contains(candidateHash) {
            return
        }
        seenHashes.insert(candidateHash)
        results.append(candidate)
    }

    func appendResults(_ candidates: [AXUIElement]) {
        for candidate in candidates {
            appendResult(candidate)
        }
    }

    appendResults(axElementArrayValue(element, "AXVisibleChildren"))
    appendResult(axElementValue(element, "AXContents"))

    if let role {
        for attribute in roleSpecificArrayChildAttributes[role] ?? [] {
            appendResults(axElementArrayValue(element, attribute))
        }

        for attribute in roleSpecificSingleChildAttributes[role] ?? [] {
            appendResult(axElementValue(element, attribute))
        }

        if !results.isEmpty {
            return results
        }

        if !safeFallbackChildRoles.contains(role) {
            return []
        }
    }

    if !results.isEmpty {
        return results
    }

    return axElementArrayValue(element, kAXChildrenAttribute as String)
}

func axActions(_ element: AXUIElement) -> [String] {
    trace("actions:start id=\(elementHash(element))")
    var actionsRef: CFArray?
    let result = AXUIElementCopyActionNames(element, &actionsRef)
    if result == .cannotComplete {
        AxDiagnostics.shared.recordOOP()
    }
    guard result == .success, let actionsRef else {
        trace("actions:end id=\(elementHash(element)) result=\(result.rawValue) count=0")
        return []
    }
    let actions = (actionsRef as NSArray).compactMap { $0 as? String }
    trace("actions:end id=\(elementHash(element)) result=\(result.rawValue) count=\(actions.count)")
    return actions
}

// Helper that pulls a string value out of a heterogeneous AnyObject result,
// matching the same coercion rules `axStringValue` uses for single reads.
func coerceString(_ raw: AnyObject?) -> String? {
    guard let raw else { return nil }
    if let s = raw as? String { return trimmed(s) }
    if let n = raw as? NSNumber { return n.stringValue }
    return nil
}

func coerceBool(_ raw: AnyObject?) -> Bool? {
    guard let raw else { return nil }
    if let b = raw as? Bool { return b }
    if let n = raw as? NSNumber { return n.boolValue }
    return nil
}

func coerceElement(_ raw: AnyObject?) -> AXUIElement? {
    guard let raw else { return nil }
    guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(raw, to: AXUIElement.self)
}

func coerceElementArray(_ raw: AnyObject?) -> [AXUIElement] {
    guard let raw else { return [] }
    guard CFGetTypeID(raw) == CFArrayGetTypeID() else { return [] }
    let arrayValue = unsafeBitCast(raw, to: CFArray.self)
    let count = CFArrayGetCount(arrayValue)
    var results: [AXUIElement] = []
    results.reserveCapacity(count)
    for index in 0..<count {
        let pointer = CFArrayGetValueAtIndex(arrayValue, index)
        results.append(unsafeBitCast(pointer, to: AXUIElement.self))
    }
    return results
}

func coercePoint(_ raw: AnyObject?) -> CGPoint? {
    guard let raw else { return nil }
    guard CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let axValue = raw as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

func coerceSize(_ raw: AnyObject?) -> CGSize? {
    guard let raw else { return nil }
    guard CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let axValue = raw as! AXValue
    guard AXValueGetType(axValue) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

func coerceURL(_ raw: AnyObject?) -> String? {
    guard let raw else { return nil }
    if let url = raw as? URL { return url.absoluteString }
    if let s = raw as? String { return trimmed(s) }
    return nil
}

func valueTypeName(_ raw: AnyObject?) -> String? {
    guard let raw else { return nil }
    if CFGetTypeID(raw) == CFBooleanGetTypeID() {
        return "boolean"
    }
    if let stringValue = raw as? String, !stringValue.isEmpty {
        return "string"
    }
    if let urlValue = raw as? URL, !urlValue.absoluteString.isEmpty {
        return "string"
    }
    if let numberValue = raw as? NSNumber {
        return numericValueTypeName(numberValue)
    }
    guard CFGetTypeID(raw) == AXValueGetTypeID() else {
        return nil
    }
    let axValue = raw as! AXValue
    switch AXValueGetType(axValue) {
    case .cgPoint: return "point"
    case .cgSize: return "size"
    case .cgRect: return "rect"
    case .cfRange: return "range"
    case .axError: return "error"
    case .illegal: return nil
    @unknown default: return nil
    }
}

func snapshotRoots(for app: AXUIElement) -> [AXUIElement] {
    var roots: [AXUIElement] = []
    let rootBatch = axBatchedAttributes(
        app,
        [
            kAXFocusedWindowAttribute as String,
            kAXMainWindowAttribute as String,
            kAXFocusedUIElementAttribute as String,
            kAXMenuBarAttribute as String,
        ]
    )

    appendUniqueElement(
        coerceElement(rootBatch[kAXFocusedWindowAttribute as String]),
        into: &roots,
        excluding: app
    )
    appendUniqueElement(
        coerceElement(rootBatch[kAXMainWindowAttribute as String]),
        into: &roots,
        excluding: app
    )
    appendUniqueElement(
        coerceElement(rootBatch[kAXFocusedUIElementAttribute as String]),
        into: &roots,
        excluding: app
    )
    // Menu bar lives off the app element, not under any window. Including it
    // is what lets us drive apps in the background even when the window AX
    // tree is shallow (e.g. Spotify): every app exposes File/Edit/Playback/etc.
    // as menu bar items, and `AXPress` on a menu item works without focus.
    appendUniqueElement(
        coerceElement(rootBatch[kAXMenuBarAttribute as String]),
        into: &roots,
        excluding: app
    )

    if roots.isEmpty {
        roots.append(app)
    }

    return roots
}

func primaryLabel(
    title: String?,
    description: String?,
    value: String?,
    identifier: String?
) -> String? {
    truncateValue(title) ??
        truncateValue(description) ??
        truncateValue(value) ??
        truncateValue(identifier)
}

func nodeSignature(
    role: String,
    title: String?,
    description: String?,
    identifier: String?
) -> String {
    let label = primaryLabel(
        title: title,
        description: description,
        value: nil,
        identifier: identifier
    )
    return label.map { "\(role):\(normalized($0))" } ?? role
}

func nodeDetails(for element: AXUIElement) -> NodeDetails {
    // First batched read: cheap "always need" attributes that we use to decide
    // whether the node deserves the deeper attribute set. role + title + focus
    // + value (some roles always carry it).
    let firstBatch = axBatchedAttributes(
        element,
        [
            kAXRoleAttribute as String,
            kAXTitleAttribute as String,
            kAXFocusedAttribute as String,
            kAXValueAttribute as String,
            kAXURLAttribute as String,
        ]
    )

    let role = coerceString(firstBatch[kAXRoleAttribute as String]) ?? "AXUnknown"
    let titleRaw = coerceString(firstBatch[kAXTitleAttribute as String])
    let title = truncateValue(titleRaw)
    let actionableByRole =
        interactiveRoles.contains(role) ||
        role == kAXWindowRole as String
    let focused = actionableByRole
        ? coerceBool(firstBatch[kAXFocusedAttribute as String])
        : nil
    let likelyActionable = actionableByRole || focused == true

    let urlRaw = coerceURL(firstBatch[kAXURLAttribute as String])
    let url = truncateValue(urlRaw)
    let rawValue = firstBatch[kAXValueAttribute as String]
    let valueType = valueTypeName(rawValue)
    let shouldInspectValueAttribute =
        rawValue != nil ||
        valueBearingRoles.contains(role) ||
        likelyActionable
    let settable = shouldInspectValueAttribute
        ? axAttributeSettable(element, kAXValueAttribute as String)
        : nil

    // Second batched read: the deeper attribute set, only if the node is
    // potentially actionable. This avoids paying ~6 round-trips on every
    // static-text leaf node.
    var subrole: String? = nil
    var description: String? = nil
    var details: String? = nil
    var help: String? = nil
    var identifier: String? = nil
    var enabled: Bool? = nil
    var selected: Bool? = nil
    var frame: Rect? = nil
    let shouldReadValue = valueBearingRoles.contains(role) || likelyActionable
    var value: String? = shouldReadValue
        ? truncateValue(coerceString(rawValue))
        : nil
    var actions: [String] = []

    if likelyActionable {
        let secondBatch = axBatchedAttributes(
            element,
            [
                kAXSubroleAttribute as String,
                kAXDescriptionAttribute as String,
                kAXIdentifierAttribute as String,
                kAXEnabledAttribute as String,
                kAXSelectedAttribute as String,
                kAXPositionAttribute as String,
                kAXSizeAttribute as String,
                "AXValueDescription",
                kAXHelpAttribute as String,
            ]
        )
        subrole = coerceString(secondBatch[kAXSubroleAttribute as String])
        description = truncateValue(coerceString(secondBatch[kAXDescriptionAttribute as String]))
        details = truncateValue(coerceString(secondBatch["AXValueDescription"]))
        help = truncateValue(coerceString(secondBatch[kAXHelpAttribute as String]))
        identifier = truncateValue(coerceString(secondBatch[kAXIdentifierAttribute as String]))
        enabled = coerceBool(secondBatch[kAXEnabledAttribute as String])
        selected = coerceBool(secondBatch[kAXSelectedAttribute as String])
        frame = rectFrom(
            position: coercePoint(secondBatch[kAXPositionAttribute as String]),
            size: coerceSize(secondBatch[kAXSizeAttribute as String])
        )
        actions = axActions(element)
        if value == nil {
            // Some elements only expose value lazily; pick it up here.
            value = truncateValue(axStringValue(element, kAXValueAttribute as String))
        }
    } else if selectableRoles.contains(role) {
        // Selection-bearing leaf rows: cheap single read.
        selected = axBoolValue(element, kAXSelectedAttribute as String)
    }

    return NodeDetails(
        role: role,
        subrole: subrole,
        title: title,
        description: description,
        value: value,
        valueType: valueType,
        settable: settable,
        details: details,
        help: help,
        identifier: identifier,
        url: url,
        enabled: enabled,
        focused: focused,
        selected: selected,
        frame: frame,
        actions: actions
    )
}

func isActionableNode(_ details: NodeDetails) -> Bool {
    if !details.actions.isEmpty {
        return true
    }
    if interactiveRoles.contains(details.role) {
        return true
    }
    return details.focused == true
}

final class SnapshotBuilder {
    private let maxDepth: Int
    private let maxNodes: Int
    private(set) var warnings: [String] = []
    private(set) var refs: [String: RefEntry] = [:]
    private(set) var indices: [String: RefEntry] = [:]
    private var nextRef = 1
    private var nextIndex = 0
    private var nodeCount = 0
    private var warnedDepth = false
    private var warnedNodeLimit = false
    private var occurrenceCounts: [String: Int] = [:]
    private var visitedElements: Set<Int> = []

    init(maxDepth: Int, maxNodes: Int) {
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
    }

    func buildNode(
        element: AXUIElement,
        depth: Int,
        childPath: [Int],
        ancestry: [String],
        windowTitle: String?
    ) -> SnapshotNode? {
        if nodeCount >= maxNodes {
            if !warnedNodeLimit {
                warnings.append("Snapshot reached the node limit and was truncated.")
                warnedNodeLimit = true
            }
            return nil
        }

        let visitKey = elementHash(element)
        if visitedElements.contains(visitKey) {
            return nil
        }
        visitedElements.insert(visitKey)

        let details = nodeDetails(for: element)
        let currentWindowTitle =
            details.role == kAXWindowRole as String
                ? details.title ?? windowTitle
                : windowTitle

        let index = nextIndex
        nextIndex += 1
        nodeCount += 1
        let signature = nodeSignature(
            role: details.role,
            title: details.title,
            description: details.description,
            identifier: details.identifier
        )
        let nextAncestry = Array((ancestry + [signature]).suffix(8))
        let primary = primaryLabel(
            title: details.title,
            description: details.description,
            value: details.value,
            identifier: details.identifier
        )
        let occurrenceKey = [
            details.role,
            normalized(primary),
            normalized(details.identifier),
            normalized(currentWindowTitle),
        ].joined(separator: "|")
        let occurrence = (occurrenceCounts[occurrenceKey] ?? 0) + 1
        occurrenceCounts[occurrenceKey] = occurrence

        var children: [SnapshotNode] = []
        if depth < maxDepth {
            let rawChildren = axChildren(element, role: details.role)
            for (index, child) in rawChildren.enumerated() {
                if let node = buildNode(
                    element: child,
                    depth: depth + 1,
                    childPath: childPath + [index],
                    ancestry: nextAncestry,
                    windowTitle: currentWindowTitle
                ) {
                    children.append(node)
                }
            }
        } else if !warnedDepth {
            warnings.append("Snapshot reached the max depth and omitted deeper descendants.")
            warnedDepth = true
        }

        let indexToken = String(index)
        indices[indexToken] = RefEntry(
            ref: indexToken,
            index: index,
            role: details.role,
            subrole: details.subrole,
            primaryLabel: primary,
            title: details.title,
            description: details.description,
            value: details.value,
            valueType: details.valueType,
            settable: details.settable,
            details: details.details,
            help: details.help,
            identifier: details.identifier,
            url: details.url,
            windowTitle: currentWindowTitle,
            childPath: childPath,
            ancestry: nextAncestry,
            occurrence: occurrence,
            enabled: details.enabled,
            focused: details.focused,
            selected: details.selected,
            frame: details.frame,
            actions: details.actions
        )

        var ref: String?
        if isActionableNode(details) {
            ref = "@d\(nextRef)"
            nextRef += 1
            if let ref {
                refs[ref] = RefEntry(
                    ref: ref,
                    index: index,
                    role: details.role,
                    subrole: details.subrole,
                    primaryLabel: primary,
                    title: details.title,
                    description: details.description,
                    value: details.value,
                    valueType: details.valueType,
                    settable: details.settable,
                    details: details.details,
                    help: details.help,
                    identifier: details.identifier,
                    url: details.url,
                    windowTitle: currentWindowTitle,
                    childPath: childPath,
                    ancestry: nextAncestry,
                    occurrence: occurrence,
                    enabled: details.enabled,
                    focused: details.focused,
                    selected: details.selected,
                    frame: details.frame,
                    actions: details.actions
                )
            }
        }

        return SnapshotNode(
            index: index,
            ref: ref,
            role: details.role,
            subrole: details.subrole,
            title: details.title,
            description: details.description,
            value: details.value,
            valueType: details.valueType,
            settable: details.settable,
            details: details.details,
            help: details.help,
            identifier: details.identifier,
            url: details.url,
            enabled: details.enabled,
            focused: details.focused,
            selected: details.selected,
            frame: details.frame,
            actions: details.actions,
            children: children
        )
    }

    func currentNodeCount() -> Int {
        nodeCount
    }
}

func ensureTargetAllowed(_ app: NSRunningApplication) throws {
    let forbidden = forbiddenBundleIdentifiers()
    if let bundleId = app.bundleIdentifier, forbidden.contains(bundleId) {
        throw NSError(domain: "desktop_automation", code: 30, userInfo: [
            NSLocalizedDescriptionKey:
                "stella-computer is not allowed to control '\(bundleId)' for safety reasons. Set STELLA_COMPUTER_FORBIDDEN_BUNDLES to override (not recommended)."
        ])
    }
}

func resolveTarget(
    pid: Int32?,
    appName: String?,
    bundleId: String?
) throws -> AppTarget {
    let runningApps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy != .prohibited }

    func wrap(_ app: NSRunningApplication) throws -> AppTarget {
        try ensureTargetAllowed(app)
        return AppTarget(app: app, axApp: AXUIElementCreateApplication(app.processIdentifier))
    }

    if let pid,
       let app = NSRunningApplication(processIdentifier: pid) {
        return try wrap(app)
    }

    if let bundleId = trimmed(bundleId),
       let app = runningApps.first(where: { $0.bundleIdentifier == bundleId }) {
        return try wrap(app)
    }

    if let appName = trimmed(appName) {
        let needle = normalized(appName)
        if let exact = runningApps.first(where: { normalized($0.localizedName) == needle }) {
            return try wrap(exact)
        }
        if let partial = runningApps.first(where: {
            normalized($0.localizedName).contains(needle) ||
                normalized($0.bundleIdentifier).contains(needle)
        }) {
            return try wrap(partial)
        }
    }

    // No frontmost-app fallback. The whole point of stella-computer is to
    // act on a specific app in the background without disturbing whatever
    // the user is currently doing. Falling back to frontmost would routinely
    // hijack the user's active window (and on this machine that's Stella
    // itself, which is on the forbidden list anyway). Force the caller to
    // name the target via --app, --bundle-id, or --pid.
    throw NSError(domain: "desktop_automation", code: 1, userInfo: [
        NSLocalizedDescriptionKey:
            "stella-computer requires a target app. Pass --app <name>, --bundle-id <id>, or --pid <pid>. "
            + "Use 'stella-computer list-apps' to discover the target. The frontmost-app fallback was removed "
            + "to keep stella-computer from interrupting the user's active window."
    ])
}

// Verify the target pid is still alive and resolves to the same bundle id
// we last saw. Returns a fresh AppTarget if the pid is gone but a same-bundle
// app is still running (auto-recovery for app restarts), or nil if the
// caller should report a clean error.
func revalidateTarget(_ snapshot: SnapshotDocument) -> AppTarget? {
    let workspace = NSWorkspace.shared
    if let app = workspace.runningApplications.first(where: { $0.processIdentifier == snapshot.pid }) {
        return AppTarget(app: app, axApp: AXUIElementCreateApplication(app.processIdentifier))
    }
    forgetPreparedTarget(pid: snapshot.pid)
    if let bundleId = snapshot.bundleId,
       let app = workspace.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) {
        return AppTarget(app: app, axApp: AXUIElementCreateApplication(app.processIdentifier))
    }
    return nil
}

func shouldEnableManualAccessibility(for app: NSRunningApplication) -> Bool {
    guard let bundleURL = app.bundleURL else {
        return false
    }
    let frameworksURL = bundleURL.appendingPathComponent("Contents/Frameworks")
    let fileManager = FileManager.default
    let frameworkNames = [
        "Electron Framework.framework",
        "Chromium Embedded Framework.framework",
    ]
    return frameworkNames.contains { frameworkName in
        fileManager.fileExists(
            atPath: frameworksURL.appendingPathComponent(frameworkName).path
        )
    }
}

// Note: an earlier iteration tried to enumerate renderer child pids
// via `sysctl(KERN_PROC_ALL)` + `proc_pidpath` and wake each renderer's
// AX tree separately. That's the wrong layer. CEF/Electron exposes the
// entire renderer DOM through a single `AXGroup` (or `AXWebArea`) that
// is already a child of the parent app's window. The fix is just to let
// the snapshot walker descend into `AXGroup` / `AXWebArea` instead of
// stopping at it, which is now done via `safeFallbackChildRoles`.

// Tracks per-pid one-time setup so we don't re-set kAXEnhancedUserInterface
// (which can be visually disruptive in some apps) every command invocation.
var preparedTargetPids: Set<Int32> = []

let observedAppNotificationNames: [String] = [
    kAXFocusedUIElementChangedNotification as String,
    kAXFocusedWindowChangedNotification as String,
    kAXMainWindowChangedNotification as String,
    kAXWindowCreatedNotification as String,
    kAXUIElementDestroyedNotification as String,
]

final class AutomationObserverContext {
    let pid: Int32

    init(pid: Int32) {
        self.pid = pid
    }
}

final class ObservedAutomationTarget {
    let pid: Int32
    let bundleId: String?
    let observer: AXObserver
    let appElement: AXUIElement
    let context: AutomationObserverContext
    var installedNotifications: [String]
    var lastEventAt: Date?
    var eventCounts: [String: Int]

    init(
        pid: Int32,
        bundleId: String?,
        observer: AXObserver,
        appElement: AXUIElement,
        context: AutomationObserverContext
    ) {
        self.pid = pid
        self.bundleId = bundleId
        self.observer = observer
        self.appElement = appElement
        self.context = context
        self.installedNotifications = []
        self.lastEventAt = nil
        self.eventCounts = [:]
    }
}

final class AutomationObserverManager {
    static let shared = AutomationObserverManager()

    private var observedTargets: [Int32: ObservedAutomationTarget] = [:]

    func ensureObserved(_ target: AppTarget) {
        let pid = target.app.processIdentifier
        if observedTargets[pid] != nil {
            return
        }

        var observerRef: AXObserver?
        let creation = AXObserverCreate(pid, { _, _, notification, refcon in
            guard let refcon else { return }
            let context = Unmanaged<AutomationObserverContext>
                .fromOpaque(refcon)
                .takeUnretainedValue()
            AutomationObserverManager.shared.recordEvent(
                pid: context.pid,
                notification: notification as String
            )
        }, &observerRef)
        guard creation == .success, let observerRef else {
            return
        }

        let context = AutomationObserverContext(pid: pid)
        let observed = ObservedAutomationTarget(
            pid: pid,
            bundleId: target.app.bundleIdentifier,
            observer: observerRef,
            appElement: target.axApp,
            context: context
        )

        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observerRef),
            CFRunLoopMode.commonModes
        )

        for notificationName in observedAppNotificationNames {
            let result = AXObserverAddNotification(
                observerRef,
                target.axApp,
                notificationName as CFString,
                Unmanaged.passUnretained(context).toOpaque()
            )
            if result == .success || result == .notificationAlreadyRegistered {
                observed.installedNotifications.append(notificationName)
            }
        }

        observedTargets[pid] = observed
    }

    func forget(pid: Int32) {
        guard let observed = observedTargets.removeValue(forKey: pid) else {
            return
        }
        for notificationName in observed.installedNotifications {
            _ = AXObserverRemoveNotification(
                observed.observer,
                observed.appElement,
                notificationName as CFString
            )
        }
        CFRunLoopRemoveSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observed.observer),
            CFRunLoopMode.commonModes
        )
    }

    private func recordEvent(pid: Int32, notification: String) {
        guard let observed = observedTargets[pid] else {
            return
        }
        observed.lastEventAt = Date()
        observed.eventCounts[notification, default: 0] += 1
    }
}

func prepareTargetForAutomation(_ target: AppTarget) {
    let pid = target.app.processIdentifier

    // 1) The messaging timeout applies to ALL descendants of the app element,
    //    so set it once on the app element itself, not on every leaf.
    AXUIElementSetMessagingTimeout(target.axApp, axMessagingTimeoutSeconds)

    if preparedTargetPids.contains(pid) {
        AutomationObserverManager.shared.ensureObserved(target)
        return
    }
    preparedTargetPids.insert(pid)

    // 2) Wake Electron / Chromium AX trees that are dormant by default.
    if shouldEnableManualAccessibility(for: target.app) {
        trace("target:manual-accessibility pid=\(pid)")
        _ = AXUIElementSetAttributeValue(
            target.axApp,
            "AXManualAccessibility" as CFString,
            kCFBooleanTrue
        )
    }

    // 3) Apps backed by AppKit expose a richer attribute set when this is
    //    enabled. This is what assistive technologies set when starting a
    //    session, so it's the same code path the app already supports.
    _ = AXUIElementSetAttributeValue(
        target.axApp,
        "AXEnhancedUserInterface" as CFString,
        kCFBooleanTrue
    )
    AutomationObserverManager.shared.ensureObserved(target)
}

func configureMessagingTimeout(for target: AppTarget) {
    prepareTargetForAutomation(target)
}

// Called when a target's pid disappears between snapshot and action so we
// don't keep stale "prepared" state across runs.
func forgetPreparedTarget(pid: Int32) {
    preparedTargetPids.remove(pid)
    AutomationObserverManager.shared.forget(pid: pid)
}

// MARK: - Overlay support
//
// The long-lived daemon path below owns the real session overlay state.
// Keep the older one-shot controller only as a fallback for direct helper
// execution outside daemon mode.

let overlayFadeInDuration: TimeInterval = 0.18
let legacyOverlayFadeOutDuration: TimeInterval = 0.22
let overlayHoldDuration: TimeInterval = 0.30  // visible time after fade-in completes
let legacyOverlayCursorMoveDuration: TimeInterval = 1.10
let overlayCursorPreRotationDuration: TimeInterval = 0.55
let overlayCursorPreRotationLeadFraction: CGFloat = 0.55
let overlayCursorOvershoot: CGFloat = 0.18
let overlayCursorSettleDuration: TimeInterval = 0.32
let overlayCursorMinPathDistance: CGFloat = 6
let overlayCursorBaseRotation: CGFloat = 0.18
let overlayCursorTangentLagFraction: CGFloat = 0.45
let overlayFadeOutDuration: TimeInterval = 0.18
let overlayCursorMoveDuration: TimeInterval = 0.85
let overlayCursorPathOutHandleFactor: CGFloat = 0.42
let overlayCursorPathInHandleFactor: CGFloat = 0.42
let overlayCursorTimingControl1: CGPoint = CGPoint(x: 0.42, y: 0.0)
let overlayCursorTimingControl2: CGPoint = CGPoint(x: 0.58, y: 1.0)
let overlayCursorMaxAngleRateRadPerSec: CGFloat = 9.5
let overlayCursorTangentCarryoverFraction: CGFloat = 1.0
let overlayCursorLoadingWiggleAmplitudeDegrees: CGFloat = 4.5
let overlayCursorLoadingWiggleFrequencyHz: CGFloat = 1.6
let overlayCursorLoadingWiggleRampDuration: TimeInterval = 0.22
let overlayCursorClickCloseEnoughProgress: CGFloat = 0.88
let overlayCursorClickCloseEnoughDistance: CGFloat = 18
let overlayCursorClickPressDuration: TimeInterval = 0.055
let overlayCursorClickPulseDuration: TimeInterval = 0.18
let overlayCursorClickPressedScale: CGFloat = 0.92
let overlayCursorClickReleaseOvershootScale: CGFloat = 1.03
let overlayIdleTimeout: TimeInterval = 20.0
let overlayCursorTailAnchor = CGPoint(x: 15, y: 14)
let overlayCursorTailLength: CGFloat = 16.0
let overlayCursorTailBaseWidth: CGFloat = 6.4
let overlayCursorTailTipWidth: CGFloat = 0.7
let overlayCursorTailSegmentCount = 14
let overlayCursorTailIdleWiggleAmplitude: CGFloat = 1.6
let overlayCursorTailMoveWiggleAmplitude: CGFloat = 3.4
let overlayCursorTailWiggleFrequencyHz: CGFloat = 1.55
let overlayCursorTailWaveNumber: CGFloat = 1.35
let overlayCursorTailRestingCurl: CGFloat = 0.0

final class ActionOverlayWindow: NSPanel {
    init(frame: CGRect) {
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        level = .normal
        collectionBehavior = [
            .ignoresCycle,
            .fullScreenAuxiliary,
        ]
        isMovableByWindowBackground = false
        isReleasedWhenClosed = false
        setFrame(frame, display: false)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// Programmatic cursor sprite. Draws a small white pointer with a soft
// drop shadow and a thin black outline so it remains visible on both
// light and dark surfaces. Drawn once per process and cached.
//
// Shape: sleek triangular pointer, 24pt × 30pt, anchor at the tip.
private var cachedSoftwareCursorImage: NSImage?

func softwareCursorImage() -> NSImage {
    if let cached = cachedSoftwareCursorImage { return cached }
    let size = NSSize(width: 30, height: 38)
    let image = NSImage(size: size, flipped: false) { rect in
        guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
        let path = CGMutablePath()
        path.move(to: CGPoint(x: rect.width / 2, y: rect.height - 2))
        path.addLine(to: CGPoint(x: rect.width - 7, y: 14))
        path.addLine(to: CGPoint(x: 7, y: 14))
        path.closeSubpath()
        guard
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
            let gradient = CGGradient(
                colorsSpace: colorSpace,
                colors: [
                    NSColor(calibratedWhite: 1, alpha: 0.98).cgColor,
                    NSColor(calibratedRed: 0.82, green: 0.85, blue: 0.89, alpha: 0.98).cgColor,
                ] as CFArray,
                locations: [0, 1]
            )
        else {
            return false
        }
        ctx.saveGState()
        ctx.setShadow(
            offset: CGSize(width: 0, height: -1),
            blur: 4,
            color: NSColor.black.withAlphaComponent(0.4).cgColor
        )
        ctx.setFillColor(NSColor.white.withAlphaComponent(0.98).cgColor)
        ctx.addPath(path)
        ctx.fillPath()
        ctx.restoreGState()

        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()
        ctx.drawLinearGradient(
            gradient,
            start: CGPoint(x: rect.width / 2, y: rect.height - 2),
            end: CGPoint(x: rect.width / 2, y: 14),
            options: []
        )
        ctx.restoreGState()

        ctx.saveGState()
        ctx.setLineJoin(.round)
        ctx.setLineCap(.round)
        ctx.setStrokeColor(NSColor(calibratedWhite: 0.08, alpha: 0.72).cgColor)
        ctx.setLineWidth(1.2)
        ctx.addPath(path)
        ctx.strokePath()
        ctx.restoreGState()
        return true
    }
    cachedSoftwareCursorImage = image
    return image
}

// One-shot AppKit bootstrap for the overlay path. The CLI is launched as a
// stdio process (activationPolicy == .prohibited), so the very first call
// into AppKit / SkyLight tears down with `Assertion failed: (did_initialize),
// CGS_REQUIRE_INIT` because we have no WindowServer connection yet. Calling
// `setActivationPolicy(.accessory)` is necessary but not sufficient — we
// also have to give NSApplication a chance to `finishLaunching`, which
// establishes the SkyLight connection. After this runs once per process,
// every subsequent NSScreen / NSPanel call works.
//
// This is wrapped in `tryBootstrapAppKit()` so that, when WindowServer
// itself can't be reached (headless ssh, stripped environment, missing
// DISPLAY-equivalent), we degrade gracefully: the overlay is skipped and
// the action proceeds without visual feedback rather than crashing the
// whole CLI on a CG assertion.
private var appKitBootstrapped = false
private var appKitBootstrapFailed = false

func tryBootstrapAppKit() -> Bool {
    if appKitBootstrapped { return true }
    if appKitBootstrapFailed { return false }

    // Touching CGSessionCopyCurrentDictionary is a cheap way to probe whether
    // the process actually has a WindowServer session. Returns nil when run
    // outside a logged-in graphical context (ssh, launchd job without
    // user-graphical, etc.). In those cases we must NOT touch AppKit.
    guard let _ = CGSessionCopyCurrentDictionary() as Dictionary? else {
        trace("overlay:bootstrap-failed reason=no-window-server-session")
        appKitBootstrapFailed = true
        return false
    }

    let app = NSApplication.shared
    if app.activationPolicy() != .accessory {
        _ = app.setActivationPolicy(.accessory)
    }
    // finishLaunching primes the SkyLight connection. Without it, the very
    // first NSPanel/NSScreen.main call asserts in CGInitialization.
    app.finishLaunching()
    // One run-loop tick lets WindowServer finish the handshake. Empirically
    // 0 ticks is sometimes enough on warm systems but 1 tick is bulletproof.
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))

    appKitBootstrapped = true
    trace("overlay:bootstrap-ok")
    return true
}

final class ActionOverlayController {
    private var window: ActionOverlayWindow?
    private var cursorLayer: CALayer?

    func show(at _: CGRect, cursorAt cursorPoint: CGPoint, viewportFrame: CGRect) {
        // Bootstrap AppKit before we touch any AppKit/SkyLight types. If the
        // bootstrap fails (no WindowServer session), bail out silently so the
        // caller's action body still runs.
        guard tryBootstrapAppKit() else { return }
        let viewportCenter = CGPoint(x: viewportFrame.midX, y: viewportFrame.midY)
        guard let screen = screenContaining(point: viewportCenter) ?? screenContaining(point: cursorPoint) ?? NSScreen.main else {
            return
        }

        let winFrame = appKitFrame(fromAXRect: viewportFrame, screen: screen)
        let win = ActionOverlayWindow(frame: winFrame)
        let host = OverlayHostView(frame: NSRect(origin: .zero, size: winFrame.size))
        host.wantsLayer = true
        host.layer?.backgroundColor = .clear
        win.contentView = host

        let cursor = makeCursorLayer(at: cursorPoint, viewportFrame: viewportFrame, screen: screen)
        host.layer?.addSublayer(cursor)
        cursorLayer = cursor

        // Fade-in from 0 to 1 with a quick spring-y curve.
        host.layer?.opacity = 0
        win.alphaValue = 1
        win.orderFrontRegardless()
        self.window = win

        let fadeIn = CABasicAnimation(keyPath: "opacity")
        fadeIn.fromValue = 0
        fadeIn.toValue = 1
        fadeIn.duration = overlayFadeInDuration
        fadeIn.timingFunction = CAMediaTimingFunction(controlPoints: 0.34, 1.56, 0.64, 1)
        fadeIn.fillMode = .forwards
        fadeIn.isRemovedOnCompletion = false
        host.layer?.add(fadeIn, forKey: "fadeIn")
        host.layer?.opacity = 1
        host.layer?.displayIfNeeded()
        win.displayIfNeeded()
        CATransaction.flush()
    }

    func moveCursor(to point: CGPoint, viewportFrame: CGRect) {
        guard let cursor = cursorLayer else { return }
        let dest = overlayLocalPoint(fromAXPoint: point, viewportFrame: viewportFrame)
        animateCursorAlongCurve(cursor, to: dest, bowSign: 1)
    }

    func hide() {
        guard let win = window, let host = win.contentView else { return }
        let fadeOut = CABasicAnimation(keyPath: "opacity")
        fadeOut.fromValue = 1
        fadeOut.toValue = 0
        fadeOut.duration = legacyOverlayFadeOutDuration
        fadeOut.timingFunction = CAMediaTimingFunction(name: .easeIn)
        fadeOut.fillMode = .forwards
        fadeOut.isRemovedOnCompletion = false
        host.layer?.add(fadeOut, forKey: "fadeOut")
        host.layer?.opacity = 0
        host.layer?.displayIfNeeded()
        win.displayIfNeeded()
        CATransaction.flush()
        runAnimationLoop(for: legacyOverlayFadeOutDuration + 0.03)
        win.orderOut(nil)
        window = nil
        cursorLayer = nil
    }

    private func makeCursorLayer(at point: CGPoint, viewportFrame: CGRect, screen: NSScreen) -> CALayer {
        let img = softwareCursorImage()
        let layer = CALayer()
        layer.contents = img
        layer.contentsScale = screen.backingScaleFactor
        let size = img.size
        // Anchor at the cursor tip so rotation
        // pivots around the visible action point rather than the sprite
        // center.
        layer.bounds = CGRect(origin: .zero, size: size)
        layer.anchorPoint = CGPoint(x: 0.5, y: 36.0 / 38.0)
        layer.position = overlayLocalPoint(fromAXPoint: point, viewportFrame: viewportFrame)
        setCursorRotation(layer, rotation: overlayCursorBaseRotation)
        layer.shadowColor = NSColor.black.cgColor
        layer.shadowOpacity = 0.35
        layer.shadowRadius = 4
        layer.shadowOffset = CGSize(width: 0, height: -1)
        return layer
    }

    private func screenContaining(point: CGPoint) -> NSScreen? {
        for screen in NSScreen.screens {
            if topLeftFrame(for: screen).contains(point) { return screen }
        }
        return nil
    }
}

// NSView subclass that hosts the overlay layers. Layer-backed so we can add
// CAShapeLayers + CALayers directly without per-view drawing.
final class OverlayHostView: NSView {
    override var isFlipped: Bool { false } // AppKit default; bottom-left origin
    override func mouseDown(with event: NSEvent) { /* click-through */ }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { false }
}

func runAnimationLoop(for duration: TimeInterval) {
    guard duration > 0 else { return }
    let deadline = Date().addingTimeInterval(duration)
    while Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.016))
    }
}

func topLeftFrame(for screen: NSScreen) -> CGRect {
    let primaryMaxY = NSScreen.screens.first?.frame.maxY ?? 0
    return CGRect(
        x: screen.frame.origin.x,
        y: primaryMaxY - screen.frame.maxY,
        width: screen.frame.width,
        height: screen.frame.height
    )
}

func appKitFrame(fromAXRect rect: CGRect, screen: NSScreen) -> CGRect {
    let screenTopLeft = topLeftFrame(for: screen)
    let localX = rect.origin.x - screenTopLeft.origin.x
    let localYTop = rect.origin.y - screenTopLeft.origin.y
    let localYBottom = screen.frame.height - localYTop - rect.height
    return CGRect(
        x: screen.frame.origin.x + localX,
        y: screen.frame.origin.y + localYBottom,
        width: rect.width,
        height: rect.height
    )
}

func overlayLocalPoint(fromAXPoint point: CGPoint, viewportFrame: CGRect) -> CGPoint {
    CGPoint(
        x: point.x - viewportFrame.origin.x,
        y: viewportFrame.height - (point.y - viewportFrame.origin.y)
    )
}

func rotationForHeading(dx: CGFloat, dy: CGFloat) -> CGFloat {
    let safeDx = (dx == 0 && dy == 0) ? 1 : dx
    return atan2(safeDx, dy)
}

func cursorRotation(from layer: CALayer?) -> CGFloat? {
    guard let layer else { return nil }
    return atan2(layer.transform.m12, layer.transform.m11)
}

func setCursorRotation(_ layer: CALayer, rotation: CGFloat) {
    layer.transform = CATransform3DMakeRotation(rotation, 0, 0, 1)
}

func setCursorTransform(_ layer: CALayer, rotation: CGFloat, scale: CGFloat) {
    var transform = CATransform3DIdentity
    transform = CATransform3DScale(transform, scale, scale, 1)
    transform = CATransform3DRotate(transform, rotation, 0, 0, 1)
    layer.transform = transform
}

func normalizeAngle(_ angle: CGFloat) -> CGFloat {
    var normalized = angle
    while normalized <= -.pi { normalized += 2 * .pi }
    while normalized > .pi { normalized -= 2 * .pi }
    return normalized
}

func shortestAngleDelta(from current: CGFloat, to target: CGFloat) -> CGFloat {
    normalizeAngle(target - current)
}

func smoothstep(edge0: CGFloat, edge1: CGFloat, value: CGFloat) -> CGFloat {
    guard edge0 != edge1 else { return value >= edge1 ? 1 : 0 }
    let t = max(0, min(1, (value - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
}

func addPoints(_ lhs: CGPoint, _ rhs: CGPoint) -> CGPoint {
    CGPoint(x: lhs.x + rhs.x, y: lhs.y + rhs.y)
}

func subtractPoints(_ lhs: CGPoint, _ rhs: CGPoint) -> CGPoint {
    CGPoint(x: lhs.x - rhs.x, y: lhs.y - rhs.y)
}

func scalePoint(_ point: CGPoint, by scalar: CGFloat) -> CGPoint {
    CGPoint(x: point.x * scalar, y: point.y * scalar)
}

func screenContaining(point: CGPoint) -> NSScreen? {
    for screen in NSScreen.screens {
        if topLeftFrame(for: screen).contains(point) { return screen }
    }
    return nil
}

func mouseLocationInAXCoordinates(screen _: NSScreen) -> CGPoint {
    if let event = CGEvent(source: nil) {
        return event.location
    }
    let appKit = NSEvent.mouseLocation
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
    return CGPoint(x: appKit.x, y: primaryHeight - appKit.y)
}

func clampPoint(_ point: CGPoint, into rect: CGRect, inset: CGFloat = 6) -> CGPoint {
    let minX = rect.minX + inset
    let maxX = rect.maxX - inset
    let minY = rect.minY + inset
    let maxY = rect.maxY - inset
    return CGPoint(
        x: min(max(point.x, minX), maxX),
        y: min(max(point.y, minY), maxY)
    )
}

struct OverlayTargetIdentity: Equatable {
    let targetWindowID: CGWindowID?
    let pid: pid_t
    let bundleId: String?
    let windowTitle: String?
    let viewportFrame: CGRect
}

struct WindowEntry {
    let windowID: CGWindowID
    let pid: pid_t
    let frame: CGRect
    let title: String?
    let layer: Int
}

func enumerateOnScreenWindows() -> [WindowEntry] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    return raw.compactMap { entry -> WindowEntry? in
        guard let windowID = entry[kCGWindowNumber as String] as? CGWindowID,
              let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat],
              let pidNumber = entry[kCGWindowOwnerPID as String] as? Int else {
            return nil
        }
        let layer = entry[kCGWindowLayer as String] as? Int ?? 0
        if layer < 0 || layer > 3 { return nil }
        let x = bounds["X"] ?? 0
        let y = bounds["Y"] ?? 0
        let w = bounds["Width"] ?? 0
        let h = bounds["Height"] ?? 0
        if w <= 0 || h <= 0 { return nil }
        return WindowEntry(
            windowID: windowID,
            pid: pid_t(pidNumber),
            frame: CGRect(x: x, y: y, width: w, height: h),
            title: entry[kCGWindowName as String] as? String,
            layer: layer
        )
    }
}

func findTargetWindow(
    in entries: [WindowEntry],
    identity: OverlayTargetIdentity
) -> (entry: WindowEntry, indexFromFront: Int)? {
    var best: (entry: WindowEntry, indexFromFront: Int, score: CGFloat)?
    for (index, entry) in entries.enumerated() {
        if entry.pid != identity.pid { continue }
        let intersection = entry.frame.intersection(identity.viewportFrame)
        let overlapArea = intersection.isNull ? 0 : intersection.width * intersection.height
        if overlapArea <= 0 { continue }
        var score = overlapArea
        if let title = identity.windowTitle,
           let entryTitle = entry.title,
           !title.isEmpty,
           title == entryTitle {
            score *= 4
        }
        if best == nil || score > best!.score {
            best = (entry, index, score)
        }
    }
    guard let pick = best else { return nil }
    return (pick.entry, pick.indexFromFront)
}

func resolveTargetWindow(
    in entries: [WindowEntry],
    identity: OverlayTargetIdentity
) -> (entry: WindowEntry, indexFromFront: Int, resolvedBy: String)? {
    if let targetWindowID = identity.targetWindowID,
       let directIndex = entries.firstIndex(where: { $0.windowID == targetWindowID && $0.pid == identity.pid }) {
        return (entries[directIndex], directIndex, "windowId")
    }
    if let fallback = findTargetWindow(in: entries, identity: identity) {
        return (fallback.entry, fallback.indexFromFront, "identity")
    }
    return nil
}

struct BezierFunction {
    let c1: CGPoint
    let c2: CGPoint

    static let easeInEaseOut = BezierFunction(
        c1: CGPoint(x: 0.42, y: 0.0),
        c2: CGPoint(x: 0.58, y: 1.0)
    )

    private static func cubic(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat {
        let oneMinus = 1 - t
        return 3 * oneMinus * oneMinus * t * a
            + 3 * oneMinus * t * t * b
            + t * t * t
    }

    func value(at progress: CGFloat) -> CGFloat {
        let p = max(0, min(1, progress))
        if p <= 0 { return 0 }
        if p >= 1 { return 1 }
        var lo: CGFloat = 0
        var hi: CGFloat = 1
        var t: CGFloat = p
        for _ in 0..<24 {
            let x = BezierFunction.cubic(c1.x, c2.x, t)
            if abs(x - p) < 0.0005 { break }
            if x < p { lo = t } else { hi = t }
            t = (lo + hi) * 0.5
        }
        return BezierFunction.cubic(c1.y, c2.y, t)
    }
}

struct CursorMotionPath {
    let start: CGPoint
    let controlOut: CGPoint
    let controlIn: CGPoint
    let end: CGPoint

    static func make(
        start: CGPoint,
        end: CGPoint,
        launchTangent: CGPoint,
        arrivalTangent: CGPoint,
        outHandleFactor: CGFloat,
        inHandleFactor: CGFloat
    ) -> CursorMotionPath {
        let distance = hypot(end.x - start.x, end.y - start.y)
        let outLen = distance * outHandleFactor
        let inLen = distance * inHandleFactor
        let unitLaunch = normalized(launchTangent)
        let unitArrival = normalized(arrivalTangent)
        let controlOut = addPoints(start, scalePoint(unitLaunch, by: outLen))
        let controlIn = subtractPoints(end, scalePoint(unitArrival, by: inLen))
        return CursorMotionPath(start: start, controlOut: controlOut, controlIn: controlIn, end: end)
    }

    func position(at u: CGFloat) -> CGPoint {
        let t = max(0, min(1, u))
        let oneMinus = 1 - t
        let a = oneMinus * oneMinus * oneMinus
        let b = 3 * oneMinus * oneMinus * t
        let c = 3 * oneMinus * t * t
        let d = t * t * t
        return CGPoint(
            x: a * start.x + b * controlOut.x + c * controlIn.x + d * end.x,
            y: a * start.y + b * controlOut.y + c * controlIn.y + d * end.y
        )
    }

    func tangent(at u: CGFloat) -> CGPoint {
        let t = max(0, min(1, u))
        let oneMinus = 1 - t
        let a = 3 * oneMinus * oneMinus
        let b = 6 * oneMinus * t
        let c = 3 * t * t
        return CGPoint(
            x: a * (controlOut.x - start.x) + b * (controlIn.x - controlOut.x) + c * (end.x - controlIn.x),
            y: a * (controlOut.y - start.y) + b * (controlIn.y - controlOut.y) + c * (end.y - controlIn.y)
        )
    }
}

func normalized(_ v: CGPoint) -> CGPoint {
    let magnitude = hypot(v.x, v.y)
    if magnitude == 0 { return CGPoint(x: 0, y: 1) }
    return CGPoint(x: v.x / magnitude, y: v.y / magnitude)
}

func blendUnitVectors(_ a: CGPoint, _ b: CGPoint, weight: CGFloat) -> CGPoint {
    let w = max(0, min(1, weight))
    return normalized(
        CGPoint(
            x: a.x + (b.x - a.x) * w,
            y: a.y + (b.y - a.y) * w
        )
    )
}

func animateCursorAlongCurve(
    _ cursor: CALayer,
    to dest: CGPoint,
    bowSign _: CGFloat
) {
    let start = cursor.presentation()?.position ?? cursor.position
    let distance = hypot(dest.x - start.x, dest.y - start.y)

    let currentRotation = cursorRotation(from: cursor.presentation())
        ?? cursorRotation(from: cursor)
        ?? overlayCursorBaseRotation

    guard distance >= overlayCursorMinPathDistance else {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cursor.position = dest
        setCursorRotation(cursor, rotation: overlayCursorBaseRotation)
        CATransaction.commit()
        let rest = CABasicAnimation(keyPath: "transform.rotation.z")
        rest.fromValue = currentRotation
        rest.toValue = overlayCursorBaseRotation
        rest.duration = overlayCursorSettleDuration
        cursor.add(rest, forKey: "cursorRotateRest")
        return
    }

    let dx = dest.x - start.x
    let dy = dest.y - start.y
    let destHeading = rotationForHeading(dx: dx, dy: dy)
    let overshootSign: CGFloat = destHeading >= currentRotation ? 1 : -1
    let overshootHeading = destHeading + overshootSign * overlayCursorOvershoot
    let launchHeading = currentRotation + (overshootHeading - currentRotation) * overlayCursorPreRotationLeadFraction

    let launchTangent = CGPoint(x: sin(launchHeading), y: cos(launchHeading))
    let arrivalTangent = CGPoint(x: sin(destHeading), y: cos(destHeading))
    let lag = overlayCursorTangentLagFraction
    let controlOut = CGPoint(
        x: start.x + launchTangent.x * distance * lag,
        y: start.y + launchTangent.y * distance * lag
    )
    let controlIn = CGPoint(
        x: dest.x - arrivalTangent.x * distance * lag,
        y: dest.y - arrivalTangent.y * distance * lag
    )
    let path = CGMutablePath()
    path.move(to: start)
    path.addCurve(to: dest, control1: controlOut, control2: controlIn)

    let now = CACurrentMediaTime()
    let preRotationLead = overlayCursorPreRotationDuration * Double(overlayCursorPreRotationLeadFraction)

    let preRotate = CABasicAnimation(keyPath: "transform.rotation.z")
    preRotate.fromValue = currentRotation
    preRotate.toValue = overshootHeading
    preRotate.duration = overlayCursorPreRotationDuration
    preRotate.timingFunction = CAMediaTimingFunction(controlPoints: 0.34, 0.95, 0.5, 1)
    preRotate.fillMode = .forwards
    preRotate.isRemovedOnCompletion = false
    cursor.add(preRotate, forKey: "cursorPreRotate")

    let move = CAKeyframeAnimation(keyPath: "position")
    move.path = path
    move.duration = legacyOverlayCursorMoveDuration
    move.calculationMode = .linear
    move.beginTime = now + preRotationLead
    move.timingFunction = CAMediaTimingFunction(controlPoints: 0.42, 0.0, 0.58, 1.0)
    move.fillMode = .both
    move.isRemovedOnCompletion = false
    cursor.add(move, forKey: "cursorMove")

    let settleStart = preRotationLead + legacyOverlayCursorMoveDuration
    let settle = CABasicAnimation(keyPath: "transform.rotation.z")
    settle.fromValue = overshootHeading
    settle.toValue = overlayCursorBaseRotation
    settle.duration = overlayCursorSettleDuration
    settle.beginTime = now + settleStart
    settle.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    settle.fillMode = .forwards
    settle.isRemovedOnCompletion = false
    cursor.add(settle, forKey: "cursorSettle")

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    cursor.position = dest
    setCursorRotation(cursor, rotation: overlayCursorBaseRotation)
    CATransaction.commit()
}

func overlayCursorStatePath(for statePath: String) -> String {
    let url = URL(fileURLWithPath: statePath)
    let dir = url.deletingLastPathComponent()
    return dir.appendingPathComponent("last-overlay-cursor.json").path
}

func loadOverlayCursorState(statePath: String) -> CGPoint? {
    let cursorStatePath = overlayCursorStatePath(for: statePath)
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: cursorStatePath)) else {
        return nil
    }
    guard let decoded = try? JSONDecoder().decode(OverlayCursorState.self, from: data) else {
        return nil
    }
    return CGPoint(x: decoded.x, y: decoded.y)
}

func saveOverlayCursorState(statePath: String, point: CGPoint) {
    let cursorStatePath = overlayCursorStatePath(for: statePath)
    let payload = OverlayCursorState(x: point.x, y: point.y)
    guard let data = try? JSONEncoder().encode(payload) else {
        return
    }
    try? data.write(to: URL(fileURLWithPath: cursorStatePath), options: [.atomic])
}

func overlayViewportFrame(statePath: String) -> Rect? {
    if let snapshot = try? loadSnapshotState(from: statePath),
       let windowFrame = snapshot.windowFrame,
       windowFrame.width > 0,
       windowFrame.height > 0 {
        return windowFrame
    }
    return nil
}

// Legacy one-shot overlay path used only when the helper is executed
// outside daemon mode.
func withActionOverlay<T>(
    enabled: Bool,
    statePath: String,
    frame: Rect?,
    cursorPoint: CGPoint? = nil,
    body: () -> T
) -> T {
    guard enabled, let frame, frame.width > 0, frame.height > 0 else {
        return body()
    }
    guard let viewportFrame = overlayViewportFrame(statePath: statePath) else {
        return body()
    }
    let cgFrame = rectToCGRect(frame)
    let viewport = rectToCGRect(viewportFrame)
    let cursor = cursorPoint ?? frameCenter(frame)
    let previousCursor = loadOverlayCursorState(statePath: statePath)
    let overlay = ActionOverlayController()
    overlay.show(at: cgFrame, cursorAt: previousCursor ?? cursor, viewportFrame: viewport)

    // Let AppKit/CoreAnimation present the overlay window before we start any
    // movement or action body. Without a live run loop here the fade-in and
    // cursor layer can be committed too late to ever become visible.
    runAnimationLoop(for: 0.05)
    if let previousCursor,
       hypot(previousCursor.x - cursor.x, previousCursor.y - cursor.y) >= 2 {
        overlay.moveCursor(to: cursor, viewportFrame: viewport)
        let preLead = overlayCursorPreRotationDuration * Double(overlayCursorPreRotationLeadFraction)
        runAnimationLoop(for: preLead + legacyOverlayCursorMoveDuration + overlayCursorSettleDuration + 0.04)
    }

    // Brief hold so the user actually sees the cursor land before the action
    // perturbs the UI.
    runAnimationLoop(for: overlayHoldDuration)

    let result = body()

    saveOverlayCursorState(statePath: statePath, point: cursor)
    overlay.hide()
    return result
}

func overlayEnabled(_ options: ActionOptions) -> Bool {
    if envBool("STELLA_COMPUTER_NO_OVERLAY") { return false }
    return options.showOverlay
}

struct UnifiedOverlayTarget {
    let frame: CGRect
    let viewportFrame: CGRect
    let cursorPoint: CGPoint
    let interactionKind: String?
    let targetIdentity: OverlayTargetIdentity?
}

func resolvedUnifiedOverlayTarget(
    snapshot: SnapshotDocument,
    target: AppTarget,
    frame: Rect?,
    cursorPoint: CGPoint? = nil,
    interactionKind: String?
) -> UnifiedOverlayTarget? {
    guard let windowFrame = snapshot.windowFrame else { return nil }
    let viewportFrame = rectToCGRect(windowFrame)
    guard viewportFrame.width > 0, viewportFrame.height > 0 else { return nil }

    let resolvedCursorPoint: CGPoint
    if let cursorPoint {
        resolvedCursorPoint = cursorPoint
    } else if let frame {
        resolvedCursorPoint = frameCenter(frame)
    } else {
        return nil
    }

    let overlayFrame = frame.map(rectToCGRect)
        ?? CGRect(x: resolvedCursorPoint.x - 24, y: resolvedCursorPoint.y - 24, width: 48, height: 48)
    let targetWindowID = snapshot.windowId ?? resolveOnScreenWindowID(
        pid: target.app.processIdentifier,
        expectedTitle: snapshot.windowTitle,
        expectedFrame: snapshot.windowFrame
    )
    let identity = OverlayTargetIdentity(
        targetWindowID: targetWindowID,
        pid: target.app.processIdentifier,
        bundleId: snapshot.bundleId ?? target.app.bundleIdentifier,
        windowTitle: snapshot.windowTitle,
        viewportFrame: viewportFrame
    )
    return UnifiedOverlayTarget(
        frame: overlayFrame,
        viewportFrame: viewportFrame,
        cursorPoint: resolvedCursorPoint,
        interactionKind: interactionKind,
        targetIdentity: identity
    )
}

struct OverlayBusyClockState {
    let busyUntilMs: Double
    let actionReadyAtMs: Double
}

func readOverlayBusyClockState(at path: String) -> OverlayBusyClockState {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return OverlayBusyClockState(busyUntilMs: 0, actionReadyAtMs: 0)
    }
    let busyUntilMs = (raw["busyUntilMs"] as? NSNumber)?.doubleValue ?? 0
    let actionReadyAtMs = (raw["actionReadyAtMs"] as? NSNumber)?.doubleValue ?? busyUntilMs
    return OverlayBusyClockState(
        busyUntilMs: busyUntilMs,
        actionReadyAtMs: actionReadyAtMs
    )
}

final class PersistentOverlayController {
    private let busyUntilPath: String
    private var window: ActionOverlayWindow?
    private var cursorLayer: CALayer?
    private var tailGradient: CAGradientLayer?
    private var tailGradientMask: CAShapeLayer?
    private var tailStroke: CAShapeLayer?
    private var currentScreen: NSScreen?
    private var currentViewportFrame: CGRect?
    private var currentTargetIdentity: OverlayTargetIdentity?
    private var currentInteractionKind: String?
    private var lastOrderedAboveWindowID: CGWindowID?
    private var lastTargetOnScreen: Bool?
    private var animationFinishesAt: CFTimeInterval = 0
    private var pendingShow: (viewportFrame: CGRect, cursorPoint: CGPoint)?
    private var currentPosition: CGPoint?
    private var activePath: CursorMotionPath?
    private var activeTiming: BezierFunction = .easeInEaseOut
    private var activeStartTime: CFTimeInterval = 0
    private var activeDuration: TimeInterval = overlayCursorMoveDuration
    private var lastArrivalTangent: CGPoint?
    private var renderedAngle: CGFloat = overlayCursorBaseRotation
    private var idleAnimationStartedAt: CFTimeInterval?
    private var clickPulseStartedAt: CFTimeInterval?
    private var shouldTriggerClickPulse = false
    private var didTriggerClickPulseForMove = false
    private var lastTickAt: CFTimeInterval?

    init(busyUntilPath: String) {
        self.busyUntilPath = busyUntilPath
    }

    private func writeBusyUntil(remainingSeconds: TimeInterval, actionReadyInSeconds: TimeInterval? = nil) {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let busyUntilMs = nowMs + max(0, remainingSeconds) * 1000
        let actionReadyAtMs = nowMs
            + max(0, min(remainingSeconds, actionReadyInSeconds ?? remainingSeconds)) * 1000
        let payload: [String: Any] = [
            "busyUntilMs": busyUntilMs,
            "actionReadyAtMs": actionReadyAtMs,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        let url = URL(fileURLWithPath: busyUntilPath)
        let tempURL = url.appendingPathExtension("tmp")
        try? data.write(to: tempURL, options: [.atomic])
        try? FileManager.default.removeItem(at: url)
        try? FileManager.default.moveItem(at: tempURL, to: url)
    }

    func showOrMove(
        frame _: CGRect,
        viewportFrame: CGRect,
        cursorAt cursorPoint: CGPoint,
        targetIdentity: OverlayTargetIdentity?,
        interactionKind: String?
    ) {
        guard tryBootstrapAppKit() else { return }
        let now = CACurrentMediaTime()
        let viewportCenter = CGPoint(x: viewportFrame.midX, y: viewportFrame.midY)
        guard let targetScreen = screenContaining(point: viewportCenter)
            ?? screenContaining(point: cursorPoint)
            ?? NSScreen.main else {
            return
        }

        currentTargetIdentity = targetIdentity
        currentInteractionKind = interactionKind

        if window == nil || currentScreen !== targetScreen || currentViewportFrame != viewportFrame {
            rebuildWindow(screen: targetScreen, viewportFrame: viewportFrame, cursorPoint: cursorPoint)
            refreshOverlayWindowOrdering()
        }
        currentInteractionKind = interactionKind

        if isBusy(at: now) {
            pendingShow = (viewportFrame, cursorPoint)
            return
        }

        setTarget(cursorPoint, viewportFrame: viewportFrame)
    }

    func tickPendingShow() {
        guard let pending = pendingShow else { return }
        if isBusy(at: CACurrentMediaTime()) { return }
        pendingShow = nil
        setTarget(pending.cursorPoint, viewportFrame: pending.viewportFrame)
    }

    private func scheduleAnimationFinish(extraTail: TimeInterval = 0) {
        let now = CACurrentMediaTime()
        animationFinishesAt = now + activeDuration + extraTail
    }

    private func isClickLikeInteraction(_ kind: String?) -> Bool {
        switch kind {
        case "click", "click-point", "secondary-action", "perform-secondary-action":
            return true
        default:
            return false
        }
    }

    private func loadingAngleOffset(at now: CFTimeInterval) -> CGFloat {
        guard activePath == nil, window != nil else { return 0 }
        let start = idleAnimationStartedAt ?? now
        let elapsed = max(0, now - start)
        let ramp = min(1, elapsed / overlayCursorLoadingWiggleRampDuration)
        let amplitude = (overlayCursorLoadingWiggleAmplitudeDegrees * .pi / 180) * CGFloat(ramp)
        let phase = CGFloat(elapsed) * overlayCursorLoadingWiggleFrequencyHz * 2 * .pi
        return sin(phase) * amplitude
    }

    private func startClickPulseIfNeeded(at now: CFTimeInterval) {
        guard clickPulseStartedAt == nil else { return }
        clickPulseStartedAt = now
    }

    private func clickPulseScale(at now: CFTimeInterval) -> CGFloat {
        guard let startedAt = clickPulseStartedAt else { return 1 }
        let elapsed = now - startedAt
        if elapsed <= 0 {
            return 1
        }
        if elapsed >= overlayCursorClickPulseDuration {
            clickPulseStartedAt = nil
            return 1
        }
        if elapsed <= overlayCursorClickPressDuration {
            let t = CGFloat(elapsed / overlayCursorClickPressDuration)
            let eased = smoothstep(edge0: 0, edge1: 1, value: t)
            return 1 + (overlayCursorClickPressedScale - 1) * eased
        }
        let releaseElapsed = elapsed - overlayCursorClickPressDuration
        let releaseDuration = overlayCursorClickPulseDuration - overlayCursorClickPressDuration
        let t = CGFloat(releaseElapsed / max(releaseDuration, 0.0001))
        let overshoot = sin(t * .pi)
        let base = overlayCursorClickPressedScale + (1 - overlayCursorClickPressedScale) * t
        let boost = (overlayCursorClickReleaseOvershootScale - 1) * overshoot
        return base + boost
    }

    func tick() {
        refreshOverlayWindowOrdering()

        guard let cursor = cursorLayer, let position = currentPosition else {
            lastTickAt = CACurrentMediaTime()
            return
        }
        let now = CACurrentMediaTime()
        let previousTick = lastTickAt ?? (now - (1.0 / 60.0))
        let dt = min(max(now - previousTick, 1.0 / 240.0), 1.0 / 24.0)
        lastTickAt = now

        let idleAngleOffset = loadingAngleOffset(at: now)
        var clickScale = clickPulseScale(at: now)

        guard let path = activePath else {
            applyCursorState(
                cursor,
                position: position,
                rotation: renderedAngle + idleAngleOffset,
                scale: clickScale
            )
            updateTailPath(at: now, hasActivePath: false)
            return
        }

        let rawProgress = CGFloat((now - activeStartTime) / activeDuration)
        let progress = max(0, min(1, rawProgress))
        let u = activeTiming.value(at: progress)
        let nextPosition = path.position(at: u)
        let tangent = path.tangent(at: u)
        let targetAngle = rotationForHeading(dx: tangent.x, dy: tangent.y)
        let angleDelta = shortestAngleDelta(from: renderedAngle, to: targetAngle)
        let maxStep = overlayCursorMaxAngleRateRadPerSec * CGFloat(dt)
        let limited = max(-maxStep, min(maxStep, angleDelta))
        let newAngle = normalizeAngle(renderedAngle + limited)

        if shouldTriggerClickPulse && !didTriggerClickPulseForMove {
            let remainingDistance = hypot(path.end.x - nextPosition.x, path.end.y - nextPosition.y)
            if progress >= overlayCursorClickCloseEnoughProgress
                || remainingDistance <= overlayCursorClickCloseEnoughDistance {
                didTriggerClickPulseForMove = true
                startClickPulseIfNeeded(at: now)
                clickScale = clickPulseScale(at: now)
                let totalRemaining = max(0, animationFinishesAt - now)
                writeBusyUntil(remainingSeconds: totalRemaining, actionReadyInSeconds: 0)
            }
        }

        currentPosition = nextPosition
        renderedAngle = newAngle
        applyCursorState(cursor, position: nextPosition, rotation: newAngle, scale: clickScale)
        updateTailPath(at: now, hasActivePath: true)

        if progress >= 1 {
            lastArrivalTangent = normalized(path.tangent(at: 1))
            if shouldTriggerClickPulse && !didTriggerClickPulseForMove {
                didTriggerClickPulseForMove = true
                startClickPulseIfNeeded(at: now)
            }
            activePath = nil
            idleAnimationStartedAt = now
        }
    }

    func hide() {
        guard let win = window, let host = win.contentView else { return }
        let fadeOut = CABasicAnimation(keyPath: "opacity")
        fadeOut.fromValue = 1
        fadeOut.toValue = 0
        fadeOut.duration = overlayFadeOutDuration
        fadeOut.timingFunction = CAMediaTimingFunction(name: .easeIn)
        fadeOut.fillMode = .forwards
        fadeOut.isRemovedOnCompletion = false
        host.layer?.add(fadeOut, forKey: "fadeOut")
        host.layer?.opacity = 0
        CATransaction.flush()
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: overlayFadeOutDuration + 0.03))
        hideImmediate()
    }

    private func rebuildWindow(screen: NSScreen, viewportFrame: CGRect, cursorPoint: CGPoint) {
        hideImmediate(preservingTargetIdentity: true)
        let winFrame = appKitFrame(fromAXRect: viewportFrame, screen: screen)
        let win = ActionOverlayWindow(frame: winFrame)
        let hostBounds = NSRect(origin: .zero, size: winFrame.size)
        let host = OverlayHostView(frame: hostBounds)
        host.wantsLayer = true
        host.layer?.backgroundColor = .clear
        host.layer?.opacity = 1
        host.layer?.masksToBounds = true
        win.contentView = host

        let mouseAX = mouseLocationInAXCoordinates(screen: screen)
        let spawnAX = clampPoint(mouseAX, into: viewportFrame)
        let cursor = makeCursorLayer(at: spawnAX, viewportFrame: viewportFrame, screen: screen)
        host.layer?.addSublayer(cursor)
        cursorLayer = cursor
        currentPosition = cursor.position
        activePath = nil
        lastArrivalTangent = nil
        renderedAngle = overlayCursorBaseRotation
        idleAnimationStartedAt = CACurrentMediaTime()
        clickPulseStartedAt = nil
        shouldTriggerClickPulse = false
        didTriggerClickPulseForMove = false
        lastTickAt = CACurrentMediaTime()

        win.orderFrontRegardless()
        window = win
        currentScreen = screen
        currentViewportFrame = viewportFrame
        refreshOverlayWindowOrdering()
        host.layer?.displayIfNeeded()
        win.displayIfNeeded()
        CATransaction.flush()
    }

    private func refreshOverlayWindowOrdering() {
        guard let win = window else { return }
        guard let identity = currentTargetIdentity else { return }
        let entries = enumerateOnScreenWindows()
        let match = resolveTargetWindow(in: entries, identity: identity)
        let isOnScreen = match != nil
        if isOnScreen != lastTargetOnScreen {
            lastTargetOnScreen = isOnScreen
            if isOnScreen {
                win.orderFrontRegardless()
            } else {
                win.orderOut(nil)
                lastOrderedAboveWindowID = nil
            }
        }
        guard let match = match else { return }
        let targetWindowID = match.entry.windowID
        win.order(.above, relativeTo: Int(targetWindowID))
        if targetWindowID != lastOrderedAboveWindowID {
            lastOrderedAboveWindowID = targetWindowID
        }
    }

    private func setTarget(_ point: CGPoint, viewportFrame: CGRect) {
        guard cursorLayer != nil else { return }
        let dest = overlayLocalPoint(fromAXPoint: point, viewportFrame: viewportFrame)
        let start = currentPosition ?? dest
        let distance = hypot(dest.x - start.x, dest.y - start.y)

        let straightTangent = normalized(CGPoint(x: dest.x - start.x, y: dest.y - start.y))
        let launchTangent: CGPoint
        if let last = lastArrivalTangent, distance >= overlayCursorMinPathDistance {
            launchTangent = blendUnitVectors(
                last,
                straightTangent,
                weight: 1 - overlayCursorTangentCarryoverFraction
            )
        } else {
            launchTangent = straightTangent
        }
        let arrivalTangent = straightTangent

        let path = CursorMotionPath.make(
            start: start,
            end: dest,
            launchTangent: launchTangent,
            arrivalTangent: arrivalTangent,
            outHandleFactor: overlayCursorPathOutHandleFactor,
            inHandleFactor: overlayCursorPathInHandleFactor
        )

        activePath = path
        activeTiming = BezierFunction(
            c1: overlayCursorTimingControl1,
            c2: overlayCursorTimingControl2
        )
        shouldTriggerClickPulse = isClickLikeInteraction(currentInteractionKind)
        didTriggerClickPulseForMove = false
        clickPulseStartedAt = nil
        idleAnimationStartedAt = nil
        activeStartTime = CACurrentMediaTime()
        let scaled = overlayCursorMoveDuration * Double(min(1.0, max(0.45, distance / 600.0)))
        activeDuration = scaled
        let clickTail = shouldTriggerClickPulse ? overlayCursorClickPulseDuration : 0
        scheduleAnimationFinish(extraTail: clickTail)
        let totalRemaining = activeDuration + clickTail + 0.06
        let actionReady = shouldTriggerClickPulse
            ? activeDuration * Double(overlayCursorClickCloseEnoughProgress)
            : totalRemaining
        writeBusyUntil(remainingSeconds: totalRemaining, actionReadyInSeconds: actionReady)
    }

    private func makeCursorLayer(at point: CGPoint, viewportFrame: CGRect, screen: NSScreen) -> CALayer {
        let img = softwareCursorImage()
        let container = CALayer()
        container.contentsScale = screen.backingScaleFactor
        container.bounds = CGRect(origin: .zero, size: img.size)
        container.anchorPoint = CGPoint(x: 0.5, y: 36.0 / 38.0)
        container.position = overlayLocalPoint(fromAXPoint: point, viewportFrame: viewportFrame)
        setCursorTransform(container, rotation: overlayCursorBaseRotation, scale: 1)
        container.shadowColor = NSColor.black.cgColor
        container.shadowOpacity = 0.35
        container.shadowRadius = 4
        container.shadowOffset = CGSize(width: 0, height: -1)

        let initialPath = tailPath(phase: 0, amplitude: overlayCursorTailIdleWiggleAmplitude)

        let gradient = CAGradientLayer()
        gradient.contentsScale = screen.backingScaleFactor
        gradient.frame = container.bounds
        gradient.colors = [
            NSColor(calibratedWhite: 1, alpha: 0.98).cgColor,
            NSColor(calibratedRed: 0.82, green: 0.85, blue: 0.89, alpha: 0.98).cgColor,
        ]
        gradient.startPoint = CGPoint(x: 0.5, y: 1)
        gradient.endPoint = CGPoint(x: 0.5, y: 0)

        let mask = CAShapeLayer()
        mask.contentsScale = screen.backingScaleFactor
        mask.frame = container.bounds
        mask.fillColor = NSColor.white.cgColor
        mask.path = initialPath
        gradient.mask = mask

        let stroke = CAShapeLayer()
        stroke.contentsScale = screen.backingScaleFactor
        stroke.frame = container.bounds
        stroke.fillColor = NSColor.clear.cgColor
        stroke.strokeColor = NSColor(calibratedWhite: 0.08, alpha: 0.72).cgColor
        stroke.lineWidth = 1.2
        stroke.lineJoin = .round
        stroke.lineCap = .round
        stroke.path = initialPath

        container.addSublayer(gradient)
        container.addSublayer(stroke)
        tailGradient = gradient
        tailGradientMask = mask
        tailStroke = stroke

        let head = CALayer()
        head.contents = img
        head.contentsScale = screen.backingScaleFactor
        head.frame = container.bounds
        container.addSublayer(head)
        return container
    }

    private func tailPath(phase: CGFloat, amplitude: CGFloat) -> CGPath {
        let segments = max(4, overlayCursorTailSegmentCount)
        let length = overlayCursorTailLength
        let curl = overlayCursorTailRestingCurl
        let waveK = overlayCursorTailWaveNumber * .pi
        var centerline: [CGPoint] = []
        var lateralBasis: [CGPoint] = []
        for i in 0...segments {
            let s = CGFloat(i) / CGFloat(segments)
            let bend = curl * s
            let dir = CGPoint(x: -sin(bend), y: -cos(bend))
            let prev = centerline.last ?? overlayCursorTailAnchor
            let step = length / CGFloat(segments)
            let next = i == 0
                ? overlayCursorTailAnchor
                : CGPoint(x: prev.x + dir.x * step, y: prev.y + dir.y * step)
            centerline.append(next)
            lateralBasis.append(CGPoint(x: -dir.y, y: dir.x))
        }

        var lateral: [CGFloat] = []
        for i in 0...segments {
            let s = CGFloat(i) / CGFloat(segments)
            let ramp = 0.18 + 0.82 * s * s
            let wave = sin(phase + s * waveK)
            lateral.append(amplitude * ramp * wave)
        }

        var halfWidths: [CGFloat] = []
        for i in 0...segments {
            let s = CGFloat(i) / CGFloat(segments)
            let w = overlayCursorTailBaseWidth
                + (overlayCursorTailTipWidth - overlayCursorTailBaseWidth) * s
            halfWidths.append(w * 0.5)
        }

        var leftEdge: [CGPoint] = []
        var rightEdge: [CGPoint] = []
        for i in 0...segments {
            let c = centerline[i]
            let lat = lateralBasis[i]
            let off = lateral[i]
            let hw = halfWidths[i]
            let centerOffset = CGPoint(x: c.x + lat.x * off, y: c.y + lat.y * off)
            leftEdge.append(
                CGPoint(x: centerOffset.x + lat.x * hw, y: centerOffset.y + lat.y * hw)
            )
            rightEdge.append(
                CGPoint(x: centerOffset.x - lat.x * hw, y: centerOffset.y - lat.y * hw)
            )
        }

        let path = CGMutablePath()
        guard let firstLeft = leftEdge.first, let firstRight = rightEdge.first else {
            return path
        }
        path.move(to: firstLeft)
        for i in 1..<leftEdge.count {
            let prev = leftEdge[i - 1]
            let curr = leftEdge[i]
            let mid = CGPoint(x: (prev.x + curr.x) * 0.5, y: (prev.y + curr.y) * 0.5)
            path.addQuadCurve(to: mid, control: prev)
            if i == leftEdge.count - 1 {
                path.addLine(to: curr)
            }
        }

        let tip = centerline.last!
        let lastRight = rightEdge.last!
        let tipDir = lateralBasis.last!
        let beyondTip = CGPoint(
            x: tip.x - tipDir.y * overlayCursorTailTipWidth * 0.6,
            y: tip.y + tipDir.x * overlayCursorTailTipWidth * 0.6
        )
        path.addQuadCurve(to: lastRight, control: beyondTip)
        for i in stride(from: rightEdge.count - 2, through: 0, by: -1) {
            let next = rightEdge[i]
            let prev = rightEdge[i + 1]
            let mid = CGPoint(x: (prev.x + next.x) * 0.5, y: (prev.y + next.y) * 0.5)
            path.addQuadCurve(to: mid, control: prev)
            if i == 0 {
                path.addLine(to: next)
            }
        }
        path.addLine(to: firstRight)
        path.closeSubpath()
        return path
    }

    private func updateTailPath(at now: CFTimeInterval, hasActivePath: Bool) {
        guard let mask = tailGradientMask, let stroke = tailStroke else { return }
        let phase = CGFloat(now) * overlayCursorTailWiggleFrequencyHz * 2 * .pi
        let amplitude = hasActivePath
            ? overlayCursorTailMoveWiggleAmplitude
            : overlayCursorTailIdleWiggleAmplitude
        let path = tailPath(phase: phase, amplitude: amplitude)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        mask.path = path
        stroke.path = path
        CATransaction.commit()
    }

    private func applyCursorState(
        _ cursor: CALayer,
        position: CGPoint,
        rotation: CGFloat,
        scale: CGFloat = 1
    ) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        cursor.position = position
        setCursorTransform(cursor, rotation: rotation, scale: scale)
        CATransaction.commit()
    }

    private func isBusy(at now: CFTimeInterval) -> Bool {
        activePath != nil || now < animationFinishesAt
    }

    private func hideImmediate(preservingTargetIdentity: Bool = false) {
        window?.orderOut(nil)
        window = nil
        cursorLayer = nil
        tailGradient = nil
        tailGradientMask = nil
        tailStroke = nil
        currentScreen = nil
        currentViewportFrame = nil
        if !preservingTargetIdentity {
            currentTargetIdentity = nil
        }
        currentInteractionKind = nil
        lastOrderedAboveWindowID = nil
        lastTargetOnScreen = nil
        currentPosition = nil
        activePath = nil
        lastArrivalTangent = nil
        renderedAngle = overlayCursorBaseRotation
        idleAnimationStartedAt = nil
        clickPulseStartedAt = nil
        shouldTriggerClickPulse = false
        didTriggerClickPulseForMove = false
        lastTickAt = nil
    }
}

final class UnifiedAutomationOverlayService {
    private let busyUntilPath: String
    private let controller: PersistentOverlayController
    private var timer: Timer?
    private var lastActivity = Date()
    private var hasVisibleOverlay = false

    init(busyUntilPath: String) {
        self.busyUntilPath = busyUntilPath
        self.controller = PersistentOverlayController(busyUntilPath: busyUntilPath)
        try? FileManager.default.removeItem(atPath: busyUntilPath)
    }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    func perform<T>(
        enabled: Bool,
        target: UnifiedOverlayTarget?,
        body: () -> T
    ) -> T {
        guard enabled, let target else {
            return body()
        }

        waitUntilIdle()
        lastActivity = Date()
        hasVisibleOverlay = true
        controller.showOrMove(
            frame: target.frame,
            viewportFrame: target.viewportFrame,
            cursorAt: target.cursorPoint,
            targetIdentity: target.targetIdentity,
            interactionKind: target.interactionKind
        )

        if overlayInteractionIsClickLike(target.interactionKind) {
            waitUntilActionReady()
        }

        defer {
            waitUntilIdle()
        }
        return body()
    }

    func hide() {
        controller.hide()
        hasVisibleOverlay = false
    }

    private func tick() {
        controller.tick()
        controller.tickPendingShow()
        if hasVisibleOverlay, Date().timeIntervalSince(lastActivity) > overlayIdleTimeout {
            hide()
        }
    }

    private func waitUntilActionReady() {
        waitUntil {
            readOverlayBusyClockState(at: busyUntilPath).actionReadyAtMs
        }
    }

    private func waitUntilIdle() {
        waitUntil {
            readOverlayBusyClockState(at: busyUntilPath).busyUntilMs
        }
    }

    private func waitUntil(deadline: () -> Double) {
        while deadline() > Date().timeIntervalSince1970 * 1000 {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.016))
        }
    }
}

private var currentAutomationOverlayService: UnifiedAutomationOverlayService?

func overlayInteractionIsClickLike(_ kind: String?) -> Bool {
    switch kind {
    case "click", "click-point", "secondary-action", "perform-secondary-action":
        return true
    default:
        return false
    }
}

func withUnifiedActionOverlay<T>(
    enabled: Bool,
    statePath: String,
    snapshot: SnapshotDocument?,
    target: AppTarget,
    frame: Rect?,
    cursorPoint: CGPoint? = nil,
    interactionKind: String,
    body: () -> T
) -> T {
    if let service = currentAutomationOverlayService {
        let overlayTarget = snapshot.flatMap {
            resolvedUnifiedOverlayTarget(
                snapshot: $0,
                target: target,
                frame: frame,
                cursorPoint: cursorPoint,
                interactionKind: interactionKind
            )
        }
        return service.perform(enabled: enabled, target: overlayTarget, body: body)
    }
    return withActionOverlay(
        enabled: enabled,
        statePath: statePath,
        frame: frame,
        cursorPoint: cursorPoint,
        body: body
    )
}

// PNG encoder mirroring Codex Computer Use's path:
// `SCScreenshotManager.captureImage(...)` → `CGImageDestination` writing the
// PNG with `UTType.png` to a CFMutableData. No downscaling, no format
// conversion, no quality knob — the screenshot ships at the native pixel
// scale that ScreenCaptureKit produces. CGImageDestination is preferred over
// NSBitmapImageRep here because it accepts ImageIO compression hints and
// produces a slightly tighter PNG for typical UI content.
func encodePNGViaImageIO(_ image: CGImage) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
        data as CFMutableData,
        "public.png" as CFString,
        1,
        nil
    ) else {
        return nil
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        return nil
    }
    return data as Data
}

// ScreenCaptureKit-backed window capture. Falls back to /usr/sbin/screencapture
// when SCK is unavailable, or when an SCK call fails (which can happen if
// the user has not granted the bundle screen recording permission).
//
// When `pid` is provided we filter by the target app's frontmost window so
// the capture is window-isolated even when other apps overlap. When pid is
// nil we fall back to the screencapture shell-out (full screen / rect).
//
// Returns `(screenshot, warning)`: when `screenshot` is non-nil the capture
// succeeded and the file was written; when `warning` is non-nil something
// went wrong and the caller should surface the message. `includeBase64`
// controls whether the returned `Screenshot.data` is populated. Callers that
// only need a file path on disk can pass `false` to skip the encode cost,
// but the default is `true` so consumers (model agents) can read the image
// inline without a follow-up file read.
func captureScreenshot(
    to outputPath: String,
    rect: Rect?,
    pid: Int32? = nil,
    includeBase64: Bool = true
) -> (Screenshot?, String?) {
    let url = URL(fileURLWithPath: outputPath)
    do {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
    } catch {
        return (nil, "Failed to write screenshot: \(error.localizedDescription)")
    }

    // Try SCK first when we have a target pid.
    if let pid, #available(macOS 14.0, *) {
        let (screenshot, warning) = captureViaScreenCaptureKit(
            pid: pid,
            outputPath: outputPath,
            includeBase64: includeBase64
        )
        if let screenshot {
            return (screenshot, nil)
        }
        if let warning {
            // SCK explicitly failed; fall through to screencapture shell-out.
            trace("screenshot:sck-failed reason=\(warning)")
        }
    }

    // Fallback: screencapture shell-out
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    var arguments = ["-x"]
    if let rect {
        arguments.append(
            "-R\(Int(rect.x)),\(Int(rect.y)),\(Int(rect.width)),\(Int(rect.height))"
        )
    }
    arguments.append(outputPath)
    process.arguments = arguments
    do {
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            return (nil, "Failed to capture screenshot (screencapture exit \(process.terminationStatus)).")
        }
        return (
            screenshotFromOnDiskPNG(path: outputPath, includeBase64: includeBase64),
            nil
        )
    } catch {
        return (nil, "Failed to capture screenshot: \(error.localizedDescription)")
    }
}

// Read a PNG that was just written by /usr/sbin/screencapture and turn it
// into a Screenshot value. Failure here is non-fatal: callers fall back to
// returning a Screenshot with only the path populated. `nil` is returned
// only if the file genuinely cannot be opened.
func screenshotFromOnDiskPNG(path: String, includeBase64: Bool) -> Screenshot? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
        return Screenshot(
            mimeType: "image/png",
            data: "",
            path: path,
            widthPx: nil,
            heightPx: nil,
            byteCount: 0
        )
    }
    var widthPx: Int? = nil
    var heightPx: Int? = nil
    if let imageSource = CGImageSourceCreateWithData(data as CFData, nil),
       let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any] {
        widthPx = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue
        heightPx = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue
    }
    return Screenshot(
        mimeType: "image/png",
        data: includeBase64 ? data.base64EncodedString() : "",
        path: path,
        widthPx: widthPx,
        heightPx: heightPx,
        byteCount: data.count
    )
}

@available(macOS 14.0, *)
private func captureViaScreenCaptureKit(
    pid: Int32,
    outputPath: String,
    includeBase64: Bool
) -> (Screenshot?, String?) {
    let semaphore = DispatchSemaphore(value: 0)
    var capturedImage: CGImage? = nil
    var captureError: String? = nil

    SCShareableContent.getExcludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
    ) { content, error in
        defer { semaphore.signal() }
        if let error {
            captureError = "SCShareableContent failed: \(error.localizedDescription)"
            return
        }
        guard let content else {
            captureError = "SCShareableContent returned no content"
            return
        }
        // Pick the largest on-screen window owned by the target pid.
        let window = content.windows
            .lazy
            .filter { $0.owningApplication?.processID == pid && $0.isOnScreen }
            .max { lhs, rhs in
                let la = lhs.frame.width * lhs.frame.height
                let ra = rhs.frame.width * rhs.frame.height
                return la < ra
            }
        guard let window else {
            captureError = "no on-screen window for pid \(pid)"
            return
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let cfg = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        let pixelWidth = Int(window.frame.width * scale)
        let pixelHeight = Int(window.frame.height * scale)
        cfg.width = pixelWidth
        cfg.height = pixelHeight
        // Mirror Codex Computer Use's `SCStreamConfiguration` setup:
        // explicitly set `sourceRect` to the window's full content (no
        // cropping) and pin the pixel format to BGRA. Both are no-ops
        // relative to ScreenCaptureKit's defaults for a windowed
        // capture, but they make the intent explicit and match the
        // reverse-engineered Codex SkyComputerUseService path.
        cfg.sourceRect = CGRect(origin: .zero, size: window.frame.size)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = false
        cfg.scalesToFit = false

        let inner = DispatchSemaphore(value: 0)
        SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: cfg
        ) { image, err in
            defer { inner.signal() }
            if let err {
                captureError = "captureImage failed: \(err.localizedDescription)"
                return
            }
            capturedImage = image
        }
        _ = inner.wait(timeout: .now() + 5)
    }
    _ = semaphore.wait(timeout: .now() + 6)

    if let captureError {
        return (nil, captureError)
    }
    guard let cgImage = capturedImage else {
        return (nil, "captureImage returned no image")
    }

    // Encode to PNG via CGImageDestination (ImageIO) — same encoder Codex
    // Computer Use's SkyComputerUseService uses. No downscaling, no format
    // conversion: the screenshot ships at the native pixel scale that
    // ScreenCaptureKit produces.
    guard let png = encodePNGViaImageIO(cgImage) else {
        return (nil, "PNG encoding failed")
    }
    do {
        try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        trace("screenshot:sck wrote \(png.count) bytes to \(outputPath) (\(cgImage.width)x\(cgImage.height))")
        let screenshot = Screenshot(
            mimeType: "image/png",
            data: includeBase64 ? png.base64EncodedString() : "",
            path: outputPath,
            widthPx: cgImage.width,
            heightPx: cgImage.height,
            byteCount: png.count
        )
        return (screenshot, nil)
    } catch {
        return (nil, "PNG write failed: \(error.localizedDescription)")
    }
}

func writeSnapshotState(_ document: SnapshotDocument, statePath: String) throws {
    let encoder = JSONEncoder()
    let data = try encoder.encode(document)
    let url = URL(fileURLWithPath: statePath)
    try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try data.write(to: url, options: .atomic)
}

func loadSnapshotState(from statePath: String) throws -> SnapshotDocument {
    let data = try Data(contentsOf: URL(fileURLWithPath: statePath))
    return try JSONDecoder().decode(SnapshotDocument.self, from: data)
}

func tryLoadSnapshotState(from statePath: String) -> SnapshotDocument? {
    try? loadSnapshotState(from: statePath)
}

func currentWindowFrame(for target: AppTarget) -> Rect? {
    if let focusedWindow = axElementValue(target.axApp, kAXFocusedWindowAttribute as String) {
        let details = nodeDetails(for: focusedWindow)
        if let frame = details.frame {
            return frame
        }
    }

    if let mainWindow = axElementValue(target.axApp, kAXMainWindowAttribute as String) {
        let details = nodeDetails(for: mainWindow)
        if let frame = details.frame {
            return frame
        }
    }

    if let focused = axElementValue(target.axApp, kAXFocusedUIElementAttribute as String) {
        return nodeDetails(for: focused).frame
    }

    return nil
}

func failure(
    _ message: String,
    warnings: [String] = [],
    screenshotPath: String? = nil,
    screenshot: Screenshot? = nil
) -> DesktopAutomationFailure {
    DesktopAutomationFailure(
        message: message,
        warnings: warnings,
        screenshotPath: screenshotPath,
        screenshot: screenshot
    )
}

func failureWithScreenshot(
    _ message: String,
    statePath: String,
    target: AppTarget?,
    candidate: CandidateNode? = nil,
    warnings: [String] = [],
    captureDiagnosticScreenshot: Bool = true,
    inlineScreenshot: Bool = true
) -> DesktopAutomationFailure {
    guard captureDiagnosticScreenshot else {
        return failure(message, warnings: warnings)
    }

    let outputPath = derivedFailureScreenshotPath(for: statePath)
    let rect = candidate?.frame ?? target.flatMap { currentWindowFrame(for: $0) }
    let pid = target?.app.processIdentifier
    let (screenshot, screenshotWarning) = captureScreenshot(
        to: outputPath,
        rect: rect,
        pid: pid,
        includeBase64: inlineScreenshot
    )
    if let screenshotWarning {
        return failure(message, warnings: warnings + [screenshotWarning])
    }
    return failure(
        message,
        warnings: warnings,
        screenshotPath: outputPath,
        screenshot: screenshot
    )
}

func commonPrefixLength<T: Equatable>(_ lhs: [T], _ rhs: [T]) -> Int {
    let upperBound = min(lhs.count, rhs.count)
    var count = 0
    while count < upperBound && lhs[count] == rhs[count] {
        count += 1
    }
    return count
}

func frameScore(expected: Rect?, actual: Rect?) -> Int {
    guard let expected, let actual else { return 0 }
    let centerDistance = hypot(
        (expected.x + (expected.width / 2.0)) - (actual.x + (actual.width / 2.0)),
        (expected.y + (expected.height / 2.0)) - (actual.y + (actual.height / 2.0))
    )
    let sizeDistance = abs(expected.width - actual.width) + abs(expected.height - actual.height)
    let score = 30 - Int((centerDistance / 20.0) + (sizeDistance / 10.0))
    return max(0, score)
}

func exactStringScore(_ lhs: PreparedTextMatch, _ rhs: PreparedTextMatch, exactWeight: Int, containsWeight: Int) -> Int {
    guard !lhs.normalized.isEmpty, !rhs.normalized.isEmpty else { return 0 }
    if lhs.normalized == rhs.normalized {
        return exactWeight
    }
    if lhs.normalized.contains(rhs.normalized) || rhs.normalized.contains(lhs.normalized) {
        return containsWeight
    }
    return 0
}

func prepareRefEntry(_ entry: RefEntry) -> PreparedRefEntry {
    PreparedRefEntry(
        role: entry.role,
        subrole: preparedText(entry.subrole),
        primaryLabel: preparedText(entry.primaryLabel),
        title: preparedText(entry.title),
        description: preparedText(entry.description),
        value: preparedText(entry.value),
        identifier: preparedText(entry.identifier),
        url: preparedText(entry.url),
        windowTitle: preparedText(entry.windowTitle),
        childPath: entry.childPath,
        ancestry: entry.ancestry,
        occurrence: entry.occurrence,
        enabled: entry.enabled,
        focused: entry.focused,
        selected: entry.selected,
        frame: entry.frame,
        actionsSet: Set(entry.actions)
    )
}

func prepareCandidateNode(_ candidate: CandidateNode) -> PreparedCandidateNode {
    PreparedCandidateNode(
        candidate: candidate,
        subrole: preparedText(candidate.subrole),
        primaryLabel: preparedText(candidate.primaryLabel),
        title: preparedText(candidate.title),
        description: preparedText(candidate.description),
        value: preparedText(candidate.value),
        identifier: preparedText(candidate.identifier),
        url: preparedText(candidate.url),
        windowTitle: preparedText(candidate.windowTitle),
        actionsSet: Set(candidate.actions)
    )
}

func scoreCandidate(entry: PreparedRefEntry, candidate: PreparedCandidateNode) -> Int {
    var score = 0

    if entry.role == candidate.candidate.role {
        score += 50
    } else {
        return Int.min
    }

    score += exactStringScore(entry.identifier, candidate.identifier, exactWeight: 150, containsWeight: 70)
    score += tokenSimilarityScore(entry.identifier, candidate.identifier, maxScore: 24)

    score += exactStringScore(entry.primaryLabel, candidate.primaryLabel, exactWeight: 95, containsWeight: 40)
    score += tokenSimilarityScore(entry.primaryLabel, candidate.primaryLabel, maxScore: 34)

    score += exactStringScore(entry.title, candidate.title, exactWeight: 42, containsWeight: 16)
    score += tokenSimilarityScore(entry.title, candidate.title, maxScore: 16)

    score += exactStringScore(entry.description, candidate.description, exactWeight: 26, containsWeight: 10)
    score += tokenSimilarityScore(entry.description, candidate.description, maxScore: 10)

    score += exactStringScore(entry.value, candidate.value, exactWeight: 18, containsWeight: 8)
    score += tokenSimilarityScore(entry.value, candidate.value, maxScore: 8)

    if !entry.subrole.normalized.isEmpty,
       entry.subrole.normalized == candidate.subrole.normalized {
        score += 18
    }

    score += exactStringScore(entry.windowTitle, candidate.windowTitle, exactWeight: 24, containsWeight: 10)
    score += tokenSimilarityScore(entry.windowTitle, candidate.windowTitle, maxScore: 8)

    let prefix = commonPrefixLength(entry.childPath, candidate.candidate.childPath)
    score += prefix * 14
    if entry.childPath == candidate.candidate.childPath {
        score += 72
    } else {
        score -= abs(entry.childPath.count - candidate.candidate.childPath.count) * 4
    }

    if entry.occurrence == candidate.candidate.occurrence {
        score += 12
    }

    let ancestryPrefix = commonPrefixLength(entry.ancestry, candidate.candidate.ancestry)
    score += ancestryPrefix * 4
    score += frameScore(expected: entry.frame, actual: candidate.candidate.frame)

    if !entry.actionsSet.isEmpty,
       !candidate.actionsSet.isEmpty,
       !entry.actionsSet.isDisjoint(with: candidate.actionsSet) {
        score += 10
    }

    if entry.enabled == candidate.candidate.enabled, entry.enabled != nil {
        score += 6
    }
    if entry.focused == candidate.candidate.focused, entry.focused != nil {
        score += 6
    }
    if entry.selected == candidate.candidate.selected, entry.selected != nil {
        score += 6
    }

    if containsNormalizedString(entry.primaryLabel, candidate.primaryLabel) {
        score += 10
    }

    if !entry.identifier.normalized.isEmpty,
       entry.identifier.normalized == candidate.identifier.normalized,
       !entry.primaryLabel.normalized.isEmpty,
       entry.primaryLabel.normalized == candidate.primaryLabel.normalized {
        score += 60
    }

    return score
}

func collectCandidates(
    target: AppTarget,
    maxDepth: Int,
    maxNodes: Int
) -> [CandidateNode] {
    var results: [CandidateNode] = []
    var nodeCount = 0
    var occurrenceCounts: [String: Int] = [:]
    var visitedElements: Set<Int> = []

    func walk(
        element: AXUIElement,
        depth: Int,
        childPath: [Int],
        ancestry: [String],
        windowTitle: String?
    ) {
        if nodeCount >= maxNodes {
            return
        }

        let visitKey = elementHash(element)
        if visitedElements.contains(visitKey) {
            return
        }
        visitedElements.insert(visitKey)

        let details = nodeDetails(for: element)
        let currentWindowTitle =
            details.role == kAXWindowRole as String
                ? details.title ?? windowTitle
                : windowTitle
        nodeCount += 1

        let signature = nodeSignature(
            role: details.role,
            title: details.title,
            description: details.description,
            identifier: details.identifier
        )
        let nextAncestry = Array((ancestry + [signature]).suffix(8))
        let primary = primaryLabel(
            title: details.title,
            description: details.description,
            value: details.value,
            identifier: details.identifier
        )
        let occurrenceKey = [
            details.role,
            normalized(primary),
            normalized(details.identifier),
            normalized(currentWindowTitle),
        ].joined(separator: "|")
        let occurrence = (occurrenceCounts[occurrenceKey] ?? 0) + 1
        occurrenceCounts[occurrenceKey] = occurrence

        results.append(
            CandidateNode(
                element: element,
                role: details.role,
                subrole: details.subrole,
                primaryLabel: primary,
                title: details.title,
                description: details.description,
                value: details.value,
                identifier: details.identifier,
                url: details.url,
                windowTitle: currentWindowTitle,
                childPath: childPath,
                ancestry: nextAncestry,
                occurrence: occurrence,
                enabled: details.enabled,
                focused: details.focused,
                selected: details.selected,
                frame: details.frame,
                actions: details.actions
            )
        )

        if depth >= maxDepth {
            return
        }

        for (index, child) in axChildren(element, role: details.role).enumerated() {
            walk(
                element: child,
                depth: depth + 1,
                childPath: childPath + [index],
                ancestry: nextAncestry,
                windowTitle: currentWindowTitle
            )
        }
    }

    for (index, root) in snapshotRoots(for: target.axApp).enumerated() {
        walk(element: root, depth: 0, childPath: [index], ancestry: [], windowTitle: nil)
    }

    return results
}

// Maximum score `scoreCandidate` could possibly return for a given entry,
// based on which attributes are populated. Used to convert an absolute score
// into a confidence ratio so thresholds scale with how identifying the
// stored ref actually is. (A ref with no identifier/title/value can never
// score very high; a ref with all of them can score ~600+.)
func maxPossibleScore(for entry: PreparedRefEntry) -> Int {
    var max = 50 // role match (gate; without it the candidate is rejected)

    if !entry.identifier.normalized.isEmpty {
        max += 150 + 24
    }
    if !entry.primaryLabel.normalized.isEmpty {
        max += 95 + 34 + 10 // exact + token-similarity + contains-bonus
    }
    if !entry.title.normalized.isEmpty {
        max += 42 + 16
    }
    if !entry.description.normalized.isEmpty {
        max += 26 + 10
    }
    if !entry.value.normalized.isEmpty {
        max += 18 + 8
    }
    if !entry.subrole.normalized.isEmpty {
        max += 18
    }
    if !entry.windowTitle.normalized.isEmpty {
        max += 24 + 8
    }
    if !entry.identifier.normalized.isEmpty && !entry.primaryLabel.normalized.isEmpty {
        max += 60 // identifier+label super-bonus
    }
    // Path: full match (72) + per-prefix (14*N), where N is path length.
    max += 72 + 14 * Swift.max(entry.childPath.count, 1)
    max += 4 * Swift.max(entry.ancestry.count, 1)
    max += 12 // occurrence
    if entry.frame != nil { max += 30 } // best-case frameScore
    if !entry.actionsSet.isEmpty { max += 10 }
    if entry.enabled != nil { max += 6 }
    if entry.focused != nil { max += 6 }
    if entry.selected != nil { max += 6 }
    return max
}

func maxPossibleScore(for entry: RefEntry) -> Int {
    maxPossibleScore(for: prepareRefEntry(entry))
}

func rankedCandidatePrecedes(_ lhs: RankedCandidate, _ rhs: RankedCandidate) -> Bool {
    if lhs.score == rhs.score {
        return lhs.candidate.childPath.count < rhs.candidate.childPath.count
    }
    return lhs.score > rhs.score
}

func insertRankedCandidate(_ ranked: RankedCandidate, into top: inout [RankedCandidate], limit: Int) {
    guard limit > 0 else { return }
    for (index, existing) in top.enumerated() {
        if rankedCandidatePrecedes(ranked, existing) {
            top.insert(ranked, at: index)
            if top.count > limit {
                top.removeLast()
            }
            return
        }
    }
    if top.count < limit {
        top.append(ranked)
    }
}

func rankedCandidates(
    for entry: RefEntry,
    in candidates: [CandidateNode],
    limit: Int = 2
) -> [RankedCandidate] {
    let preparedEntry = prepareRefEntry(entry)
    let cap = maxPossibleScore(for: preparedEntry)
    // Cheap pre-filter: candidates that can't even reach 12% of the cap
    // aren't worth keeping in the tail. Floor at 50 so very thin entries
    // (no identifier/label) aren't pruned away entirely.
    let absoluteFloor = Swift.max(50, cap / 8)
    var top: [RankedCandidate] = []
    top.reserveCapacity(Swift.max(limit, 0))
    for candidate in candidates {
        let preparedCandidate = prepareCandidateNode(candidate)
        let score = scoreCandidate(entry: preparedEntry, candidate: preparedCandidate)
        if score < absoluteFloor {
            continue
        }
        insertRankedCandidate(
            RankedCandidate(candidate: candidate, score: score),
            into: &top,
            limit: limit
        )
    }
    return top
}

// Tunables for percentile-based gating. Override at runtime via env if a
// caller wants to relax/tighten matching for a specific app.
//
//   minimum confidence ratio the best match must clear (relative to the
//   theoretical max for this entry)
let stellaMinConfidenceRatio: Double = {
    if let raw = ProcessInfo.processInfo.environment["STELLA_COMPUTER_MIN_CONFIDENCE"],
       let v = Double(raw), v > 0, v <= 1 {
        return v
    }
    return 0.30
}()

//   minimum gap between #1 and #2 (relative to the theoretical max). A
//   small gap means the matcher is uncertain which of two candidates is
//   "the" element; we'd rather fail loudly than guess.
let stellaMinGapRatio: Double = {
    if let raw = ProcessInfo.processInfo.environment["STELLA_COMPUTER_MIN_GAP"],
       let v = Double(raw), v >= 0, v <= 1 {
        return v
    }
    return 0.07
}()

func bestCandidate(
    for entry: RefEntry,
    ranked: [RankedCandidate]
) -> ResolvedCandidate? {
    guard let best = ranked.first else {
        return nil
    }

    let preparedEntry = prepareRefEntry(entry)
    let preparedBest = prepareCandidateNode(best.candidate)

    let exactIdentifier = !preparedEntry.identifier.normalized.isEmpty &&
        preparedEntry.identifier.normalized == preparedBest.identifier.normalized
    let exactPrimaryLabel = !preparedEntry.primaryLabel.normalized.isEmpty &&
        preparedEntry.primaryLabel.normalized == preparedBest.primaryLabel.normalized
    let exactPath = preparedEntry.childPath == best.candidate.childPath
    let frameAligned = frameScore(expected: preparedEntry.frame, actual: best.candidate.frame) >= 20
    let exactURL = !preparedEntry.url.normalized.isEmpty &&
        preparedEntry.url.normalized == preparedBest.url.normalized
    let stableExactMatch = exactIdentifier
        || exactURL
        || (exactPrimaryLabel && exactPath)
        || (exactPrimaryLabel && frameAligned)

    let cap = Swift.max(maxPossibleScore(for: preparedEntry), 1)
    let confidence = Double(best.score) / Double(cap)

    // Gap test: if a runner-up is too close, declare ambiguous.
    if let second = ranked.dropFirst().first {
        let gapRatio = Double(best.score - second.score) / Double(cap)
        if !stableExactMatch && gapRatio < stellaMinGapRatio {
            return nil
        }
    }

    // Confidence test: even if there's no runner-up, the best match has to
    // clear a minimum confidence ratio to count.
    if !stableExactMatch && confidence < stellaMinConfidenceRatio {
        return nil
    }

    var warnings: [String] = []
    if !stableExactMatch {
        let pct = Int((confidence * 100).rounded())
        warnings.append("Ref resolved heuristically against the current accessibility tree (confidence \(pct)%).")
    }

    return ResolvedCandidate(
        candidate: best.candidate,
        score: best.score,
        warnings: warnings
    )
}

func preferredAction(for candidate: CandidateNode) -> String? {
    for actionName in preferredActionNames where candidate.actions.contains(actionName) {
        return actionName
    }
    return candidate.actions.first
}

func normalizedActionAlias(_ actionName: String) -> String {
    let trimmed = actionName.hasPrefix("AX") ? String(actionName.dropFirst(2)) : actionName
    return trimmed
        .replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
        .replacingOccurrences(of: "[^A-Za-z0-9]+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
}

func resolveActionName(_ requested: String, from available: [String]) -> String? {
    if available.contains(requested) {
        return requested
    }
    let needle = normalizedActionAlias(requested)
    return available.first { normalizedActionAlias($0) == needle }
}

func activationPolicyName(_ policy: NSApplication.ActivationPolicy) -> String {
    switch policy {
    case .regular:
        return "regular"
    case .accessory:
        return "accessory"
    case .prohibited:
        return "prohibited"
    @unknown default:
        return "unknown"
    }
}

func activationPolicyRank(_ policy: NSApplication.ActivationPolicy) -> Int {
    switch policy {
    case .regular:
        return 0
    case .accessory:
        return 1
    case .prohibited:
        return 2
    @unknown default:
        return 3
    }
}

func listAppsCommand() -> ListAppsPayload {
    let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy != .prohibited && $0.processIdentifier > 0 }
        .sorted { lhs, rhs in
            let lhsActive = lhs.processIdentifier == frontmostPid
            let rhsActive = rhs.processIdentifier == frontmostPid
            if lhsActive != rhsActive {
                return lhsActive && !rhsActive
            }

            let lhsRank = activationPolicyRank(lhs.activationPolicy)
            let rhsRank = activationPolicyRank(rhs.activationPolicy)
            if lhsRank != rhsRank {
                return lhsRank < rhsRank
            }

            let lhsName = normalized(lhs.localizedName ?? lhs.bundleIdentifier ?? "")
            let rhsName = normalized(rhs.localizedName ?? rhs.bundleIdentifier ?? "")
            if lhsName != rhsName {
                return lhsName < rhsName
            }

            return lhs.processIdentifier < rhs.processIdentifier
        }
        .map { app in
            ListedAppPayload(
                name: app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)",
                bundleId: app.bundleIdentifier,
                pid: app.processIdentifier,
                activationPolicy: activationPolicyName(app.activationPolicy),
                isActive: app.processIdentifier == frontmostPid
            )
        }

    return ListAppsPayload(ok: true, apps: apps, warnings: [])
}

func setFocused(_ element: AXUIElement) -> Bool {
    let result = AXUIElementSetAttributeValue(
        element,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    ) == .success
    guard result else {
        return false
    }
    return axBoolValue(element, kAXFocusedAttribute as String) != false
}

func performClick(
    candidate: CandidateNode,
    target: AppTarget,
    coordinateFallback: Bool,
    raise: Bool
) -> (Bool, String?) {
    if !alwaysSimulateInput(),
       let actionName = preferredAction(for: candidate),
       AXUIElementPerformAction(candidate.element, actionName as CFString) == .success {
        return (true, actionName)
    }

    if coordinateFallback,
       let frame = candidate.frame,
       postLeftClick(at: frameCenter(frame), target: target, raise: raise) {
        return (true, "coordinate-fallback")
    }

    return (false, nil)
}

func performSemanticAction(
    candidate: CandidateNode,
    actionName: String
) -> Bool {
    guard candidate.actions.contains(actionName) else {
        return false
    }
    return AXUIElementPerformAction(candidate.element, actionName as CFString) == .success
}

func scrollActionName(for direction: String) -> String? {
    switch normalized(direction) {
    case "up":
        return "AXScrollUpByPage"
    case "down":
        return "AXScrollDownByPage"
    case "left":
        return "AXScrollLeftByPage"
    case "right":
        return "AXScrollRightByPage"
    default:
        return nil
    }
}

func performScroll(
    candidate: CandidateNode,
    direction: String,
    pages: Int
) -> (String, [String])? {
    guard let actionName = scrollActionName(for: direction) else {
        return nil
    }
    var warnings: [String] = []
    if !candidate.actions.contains(actionName) {
        warnings.append("Element did not advertise \(actionName); Stella attempted the standard AX scroll action directly.")
    }
    _ = setFocused(candidate.element)
    for _ in 0..<pages {
        guard AXUIElementPerformAction(candidate.element, actionName as CFString) == .success else {
            return nil
        }
    }
    return (actionName, warnings)
}

// Returns (succeeded, usedAction) where usedAction is "AXValue" for the
// AX-set fast path, or "keystroke" for the typing fallback. The fallback
// is gated by `target` (when nil, only the AX path is attempted).
func setValue(
    candidate: CandidateNode,
    text: String,
    target: AppTarget? = nil,
    raise: Bool = true
) -> (Bool, String?) {
    _ = setFocused(candidate.element)

    // Some elements (Slider, ProgressIndicator) want a CFNumber, not a string.
    // We always try the string path first; numeric coercion fallback is below.
    let setStringResult = AXUIElementSetAttributeValue(
        candidate.element,
        kAXValueAttribute as CFString,
        text as CFString
    )

    if setStringResult == .success {
        let observed = normalized(axStringValue(candidate.element, kAXValueAttribute as String))
        if observed == normalized(text) {
            return (true, "AXValue")
        }
        // Set succeeded but readback differs: the app accepted the write
        // and then transformed the value (e.g. capitalized, formatted as a
        // date, truncated). Treat this as success — falling through to
        // keystroke would re-dispatch the input and risk duplicate edits
        // (Numbers cells, formatted-text fields). The caller can re-snapshot
        // to confirm whether the transformation was acceptable.
        return (true, "AXValue(transformed)")
    }

    // Numeric coercion: slider, level indicator, etc.
    if let asDouble = Double(text) {
        let number = NSNumber(value: asDouble)
        let setNumericResult = AXUIElementSetAttributeValue(
            candidate.element,
            kAXValueAttribute as CFString,
            number
        )
        if setNumericResult == .success {
            return (true, "AXValue(numeric)")
        }
    }

    // Keystroke fallback: focus + type via System Events. This works for text
    // fields that reject AXValue assignment but honor synthesized typing.
    if let target {
        // Best-effort clear: select-all then delete current value before typing.
        _ = postKeyChord("cmd+a", target: target, raise: raise)
        _ = postKeyChord("delete", target: target, raise: raise)
        if postUnicodeText(text, target: target, raise: raise) {
            // Optional readback to make sure something landed; not authoritative
            // since the app may format the value.
            return (true, "keystroke")
        }
    }

    return (false, nil)
}

func envBool(_ key: String) -> Bool {
    guard let raw = ProcessInfo.processInfo.environment[key]?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased() else {
        return false
    }
    return raw == "1" || raw == "true" || raw == "yes"
}

// Apply uniformly to click, type, press. Old click-specific name retained
// for back-compat in tests; new uniform name takes precedence if both set.
func alwaysSimulateInput() -> Bool {
    envBool("STELLA_COMPUTER_ALWAYS_SIMULATE_INPUT") ||
        envBool("STELLA_COMPUTER_ALWAYS_SIMULATE_CLICK")
}

@inline(__always)
func alwaysSimulateClick() -> Bool { alwaysSimulateInput() }

// Toggle whether System Events should bring the target frontmost before
// dispatching click/keystroke commands. Default: false. stella-computer
// drives apps via Accessibility in the background; raising would steal
// focus from whatever the user is currently doing. Action commands flip
// this on only when --raise (or STELLA_COMPUTER_RAISE=1) is passed
// explicitly. The legacy --no-raise flag and STELLA_COMPUTER_NO_RAISE
// env var are accepted as no-ops to keep older callers from breaking.
func shouldRaiseTarget(_ argOverride: Bool? = nil) -> Bool {
    if let argOverride { return argOverride }
    if envBool("STELLA_COMPUTER_RAISE") {
        return true
    }
    return false
}

// Cached compiled NSAppleScript objects keyed by source. AppleScript
// compilation is expensive (~30ms); we reuse the compiled form across
// invocations of the same source.
var compiledScriptCache: [String: NSAppleScript] = [:]

func compiledScript(for source: String) -> NSAppleScript? {
    if let cached = compiledScriptCache[source] {
        return cached
    }
    guard let script = NSAppleScript(source: source) else { return nil }
    var error: NSDictionary?
    script.compileAndReturnError(&error)
    if let error {
        trace("script:compile-error \(error)")
        return nil
    }
    compiledScriptCache[source] = script
    return script
}

func runAppleScriptSource(_ source: String) -> (Bool, String?) {
    guard let script = compiledScript(for: source) else {
        return (false, "script compilation failed")
    }
    var error: NSDictionary?
    let _ = script.executeAndReturnError(&error)
    if let error {
        let message = (error[NSAppleScript.errorMessage] as? String) ?? "unknown AppleScript error"
        let number = (error[NSAppleScript.errorNumber] as? NSNumber)?.intValue
        let combined = number.map { "\(message) (errno \($0))" } ?? message
        trace("script:run-error \(combined)")
        return (false, combined)
    }
    return (true, nil)
}

func runAppleScriptWithArgs(source: String, arguments: [String]) -> (Bool, String?) {
    guard let script = NSAppleScript(source: source) else {
        return (false, "script compilation failed")
    }
    var compileError: NSDictionary?
    script.compileAndReturnError(&compileError)
    if let compileError {
        let message = (compileError[NSAppleScript.errorMessage] as? String) ?? "compile error"
        return (false, message)
    }

    // Build NSAppleEventDescriptor of typeAEList containing the args.
    let argList = NSAppleEventDescriptor.list()
    for (index, arg) in arguments.enumerated() {
        argList.insert(NSAppleEventDescriptor(string: arg), at: index + 1)
    }

    let event = NSAppleEventDescriptor(
        eventClass: AEEventClass(kASAppleScriptSuite),
        eventID: AEEventID(kASSubroutineEvent),
        targetDescriptor: nil,
        returnID: AEReturnID(kAutoGenerateReturnID),
        transactionID: AETransactionID(kAnyTransactionID)
    )
    event.setDescriptor(NSAppleEventDescriptor(string: "run"), forKeyword: AEKeyword(keyASSubroutineName))
    event.setDescriptor(argList, forKeyword: AEKeyword(keyDirectObject))

    var runError: NSDictionary?
    let _ = script.executeAppleEvent(event, error: &runError)
    if let runError {
        let message = (runError[NSAppleScript.errorMessage] as? String) ?? "run error"
        let number = (runError[NSAppleScript.errorNumber] as? NSNumber)?.intValue
        let combined = number.map { "\(message) (errno \($0))" } ?? message
        return (false, combined)
    }
    return (true, nil)
}

func systemEventsModifierNames(for tokens: [String]) -> [String] {
    var modifiers: [String] = []
    for token in tokens.map(normalized) {
        switch token {
        case "cmd", "command", "meta", "super":
            modifiers.append("command down")
        case "ctrl", "control":
            modifiers.append("control down")
        case "alt", "option":
            modifiers.append("option down")
        case "shift":
            modifiers.append("shift down")
        default:
            continue
        }
    }
    return modifiers
}

func systemEventsModifierList(_ tokens: [String]) -> String? {
    let modifiers = systemEventsModifierNames(for: tokens)
    guard !modifiers.isEmpty else {
        return nil
    }
    return "{\(modifiers.joined(separator: ", "))}"
}

func systemEventsPreamble(for target: AppTarget, raise: Bool) -> [String] {
    var lines = [
        "tell application \"System Events\"",
        "set targetProcess to first process whose unix id is \(target.app.processIdentifier)",
        "tell targetProcess",
    ]
    if raise {
        lines.append("set frontmost to true")
    }
    return lines
}

func runSystemEventsOnTarget(
    _ target: AppTarget,
    bodyLines: [String],
    arguments: [String] = [],
    raise: Bool = true
) -> Bool {
    var sourceLines: [String] = []
    let wantsArgs = !arguments.isEmpty
    if wantsArgs {
        sourceLines.append("on run argv")
    }
    sourceLines.append(contentsOf: systemEventsPreamble(for: target, raise: raise))
    sourceLines.append(contentsOf: bodyLines)
    sourceLines.append(contentsOf: ["end tell", "end tell"])
    if wantsArgs {
        sourceLines.append("end run")
    }
    let source = sourceLines.joined(separator: "\n")
    if wantsArgs {
        let (ok, _) = runAppleScriptWithArgs(source: source, arguments: arguments)
        return ok
    }
    let (ok, _) = runAppleScriptSource(source)
    return ok
}

func simulateLeftClick(at point: CGPoint) -> Bool {
    guard let source = CGEventSource(stateID: .hidSystemState),
          let mouseDown = CGEvent(
              mouseEventSource: source,
              mouseType: .leftMouseDown,
              mouseCursorPosition: point,
              mouseButton: .left
          ),
          let mouseUp = CGEvent(
              mouseEventSource: source,
              mouseType: .leftMouseUp,
              mouseCursorPosition: point,
              mouseButton: .left
          ) else {
        return false
    }
    mouseDown.post(tap: .cghidEventTap)
    mouseUp.post(tap: .cghidEventTap)
    return true
}

func postLeftClick(at point: CGPoint, target: AppTarget, raise: Bool = true) -> Bool {
    if !alwaysSimulateInput(),
       runSystemEventsOnTarget(
           target,
           bodyLines: ["click at {\(Int(point.x)), \(Int(point.y))}"],
           raise: raise
       ) {
        trace("input:click path=system-events")
        return true
    }
    trace("input:click path=cgevent")
    return simulateLeftClick(at: point)
}

func simulateDrag(from start: CGPoint, to end: CGPoint) -> Bool {
    guard let source = CGEventSource(stateID: .hidSystemState),
          let mouseDown = CGEvent(
              mouseEventSource: source,
              mouseType: .leftMouseDown,
              mouseCursorPosition: start,
              mouseButton: .left
          ),
          let mouseUp = CGEvent(
              mouseEventSource: source,
              mouseType: .leftMouseUp,
              mouseCursorPosition: end,
              mouseButton: .left
          ) else {
        return false
    }

    mouseDown.post(tap: .cghidEventTap)
    let distance = hypot(end.x - start.x, end.y - start.y)
    let stepCount = max(4, Int(distance / 36.0))
    for step in 1...stepCount {
        let progress = CGFloat(step) / CGFloat(stepCount)
        let point = CGPoint(
            x: start.x + ((end.x - start.x) * progress),
            y: start.y + ((end.y - start.y) * progress)
        )
        guard let dragEvent = CGEvent(
            mouseEventSource: source,
            mouseType: .leftMouseDragged,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else {
            return false
        }
        dragEvent.post(tap: .cghidEventTap)
        usleep(8_000)
    }
    mouseUp.post(tap: .cghidEventTap)
    trace("input:drag path=cgevent")
    return true
}

// MARK: - NSDraggingSession content drag
//
// Codex's "Drag" tool uses NSDraggingSession (not raw mouse-drag CGEvents).
// That gives the destination app a real drag-and-drop pipeline: the right
// pasteboard types, drag-image animation, and `NSDraggingDestination`
// callbacks fire correctly. We do the same here for `drag-element`.
//
// The host of an NSDraggingSession must be an NSView in our process. We
// create a tiny transparent overlay window at the source point, host a
// `DragSourceView` in it (which conforms to `NSDraggingSource`), call
// `beginDraggingSession(...)`, then drive the cursor over to the destination
// with synthesized mouseDragged events so AppKit's drag-tracking sees the
// motion. The destination app's own drag receivers handle the drop.

final class DragSourceView: NSView, NSDraggingSource {
    var operationMask: NSDragOperation = .every
    var endResult: NSDragOperation = []
    var didEndCallback: (() -> Void)?

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        return operationMask
    }

    func draggingSession(
        _ session: NSDraggingSession,
        endedAt screenPoint: NSPoint,
        operation: NSDragOperation
    ) {
        endResult = operation
        didEndCallback?()
    }
}

func parseDragOperation(_ token: String?) -> NSDragOperation {
    switch normalized(token) {
    case "copy": return .copy
    case "link": return .link
    case "move": return .move
    case "every", "any", "": return .every
    default: return .every
    }
}

// macOS screens use a bottom-left origin in `NSScreen.frame`, but
// CoreGraphics / AX coordinates are top-left. Convert AX/CG screen
// coordinates to AppKit screen coordinates so windows land where intended.
func axPointToAppKitPoint(_ point: CGPoint) -> NSPoint {
    let mainHeight = NSScreen.screens.first?.frame.height ?? 1080
    return NSPoint(x: point.x, y: mainHeight - point.y)
}

func performNSDragSession(
    items: [NSDraggingItem],
    fromScreen: CGPoint,
    toScreen: CGPoint,
    operation: NSDragOperation
) -> (Bool, String?) {
    // NSDraggingSession requires an active NSApplication that has finished
    // launching against WindowServer. tryBootstrapAppKit() handles the
    // activation-policy promotion, the finishLaunching call, and the brief
    // run-loop tick that establishes the SkyLight connection. Without it,
    // the first NSPanel/NSScreen call asserts in CGInitialization.
    guard tryBootstrapAppKit() else {
        return (false, "drag-element requires a graphical (window-server) session")
    }

    let appKitFrom = axPointToAppKitPoint(fromScreen)
    let windowSize: CGFloat = 32
    let windowRect = NSRect(
        x: appKitFrom.x - windowSize / 2,
        y: appKitFrom.y - windowSize / 2,
        width: windowSize,
        height: windowSize
    )

    let overlay = NSPanel(
        contentRect: windowRect,
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false
    )
    overlay.isOpaque = false
    overlay.backgroundColor = .clear
    overlay.hasShadow = false
    overlay.level = .popUpMenu
    overlay.ignoresMouseEvents = false
    overlay.alphaValue = 0.01 // visible to event system, invisible to user

    let dragView = DragSourceView(frame: NSRect(x: 0, y: 0, width: windowSize, height: windowSize))
    dragView.operationMask = operation
    overlay.contentView = dragView
    overlay.orderFrontRegardless()

    guard let downEvent = NSEvent.mouseEvent(
        with: .leftMouseDown,
        location: NSPoint(x: windowSize / 2, y: windowSize / 2),
        modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: overlay.windowNumber,
        context: nil,
        eventNumber: 0,
        clickCount: 1,
        pressure: 1.0
    ) else {
        overlay.orderOut(nil)
        return (false, "failed to synthesize mouseDown for drag session")
    }

    let endSemaphore = DispatchSemaphore(value: 0)
    dragView.didEndCallback = { endSemaphore.signal() }

    _ = dragView.beginDraggingSession(
        with: items,
        event: downEvent,
        source: dragView
    )

    // Drive the cursor from source to destination on a background queue so
    // our run loop (below) is free to deliver dragging-session callbacks.
    let cursorWorker = DispatchQueue.global(qos: .userInitiated)
    cursorWorker.async {
        guard let cgSource = CGEventSource(stateID: .hidSystemState) else { return }
        let totalDistance = hypot(toScreen.x - fromScreen.x, toScreen.y - fromScreen.y)
        let stepCount = max(8, Int(totalDistance / 18.0))
        // Initial small movement to "kick" the session out of the source frame.
        usleep(40_000)
        for step in 1...stepCount {
            let progress = CGFloat(step) / CGFloat(stepCount)
            let pt = CGPoint(
                x: fromScreen.x + (toScreen.x - fromScreen.x) * progress,
                y: fromScreen.y + (toScreen.y - fromScreen.y) * progress
            )
            if let evt = CGEvent(
                mouseEventSource: cgSource,
                mouseType: .leftMouseDragged,
                mouseCursorPosition: pt,
                mouseButton: .left
            ) {
                evt.post(tap: .cghidEventTap)
            }
            usleep(7_000)
        }
        // Brief settle so destination drag-receivers can update their state.
        usleep(40_000)
        if let upEvt = CGEvent(
            mouseEventSource: cgSource,
            mouseType: .leftMouseUp,
            mouseCursorPosition: toScreen,
            mouseButton: .left
        ) {
            upEvt.post(tap: .cghidEventTap)
        }
    }

    // Spin run loop while waiting for the dragging session to end (or time out).
    let deadline = Date().addingTimeInterval(8)
    var done = false
    while !done && Date() < deadline {
        if endSemaphore.wait(timeout: .now() + .milliseconds(40)) == .success {
            done = true
            break
        }
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.04))
    }

    overlay.orderOut(nil)
    if !done {
        return (false, "drag session did not complete within timeout")
    }
    if dragView.endResult == [] {
        return (false, "drop was rejected by destination")
    }
    return (true, nil)
}

func pasteboardItemsForCandidate(
    _ candidate: CandidateNode,
    explicitType: String?
) -> ([NSDraggingItem], String)? {
    let kind = normalized(explicitType)

    // 1. Explicit URL (file:// for Finder items, https:// for browsers).
    if kind == "url" || kind == "file" || kind == "" {
        if let urlString = candidate.url, let url = URL(string: urlString) {
            let item = NSDraggingItem(pasteboardWriter: url as NSURL)
            if let frame = candidate.frame {
                item.draggingFrame = NSRect(
                    x: 0,
                    y: 0,
                    width: max(8, frame.width),
                    height: max(8, frame.height)
                )
            }
            let chosen = url.isFileURL ? "file-url" : "url"
            return ([item], chosen)
        }
        // Some Finder items expose path via title/value rather than AXURL.
        if (kind == "file" || kind == ""),
           let value = candidate.value ?? candidate.title,
           value.hasPrefix("/") || value.hasPrefix("file://") {
            let url = value.hasPrefix("file://")
                ? URL(string: value)
                : URL(fileURLWithPath: value)
            if let url {
                let item = NSDraggingItem(pasteboardWriter: url as NSURL)
                return ([item], "file-url")
            }
        }
    }

    // 2. Explicit text drag.
    if kind == "text" || kind == "" {
        if let value = candidate.value, !value.isEmpty {
            let item = NSDraggingItem(pasteboardWriter: value as NSString)
            return ([item], "text")
        }
        if kind == "text", let title = candidate.title, !title.isEmpty {
            let item = NSDraggingItem(pasteboardWriter: title as NSString)
            return ([item], "text")
        }
    }

    return nil
}

func simulateUnicodeText(_ text: String) -> Bool {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        return false
    }
    let characters = Array(text.utf16)
    guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
        return false
    }
    keyDown.keyboardSetUnicodeString(stringLength: characters.count, unicodeString: characters)
    keyUp.keyboardSetUnicodeString(stringLength: characters.count, unicodeString: characters)
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
    return true
}

func keyCode(for token: String) -> CGKeyCode? {
    let key = normalized(token)
    return namedKeyCodes[key] ?? letterKeyCodes[key] ?? digitKeyCodes[key]
}

// Maximum chunk size for a single SystemEvents `keystroke` call. Some apps
// (Notes, Mail) drop characters when fed >256 chars in one event.
let unicodeChunkSize = 200

func chunkText(_ text: String, size: Int) -> [String] {
    var chunks: [String] = []
    var index = text.startIndex
    while index < text.endIndex {
        let end = text.index(index, offsetBy: size, limitedBy: text.endIndex) ?? text.endIndex
        chunks.append(String(text[index..<end]))
        index = end
    }
    return chunks
}

func postUnicodeText(_ text: String, target: AppTarget, raise: Bool = true) -> Bool {
    if !alwaysSimulateInput() {
        let chunks = chunkText(text, size: unicodeChunkSize)
        for chunk in chunks {
            let ok = runSystemEventsOnTarget(
                target,
                bodyLines: ["keystroke (item 1 of argv)"],
                arguments: [chunk],
                raise: raise
            )
            if !ok {
                trace("input:type path=cgevent (sysevents-failed) length=\(text.count)")
                return simulateUnicodeText(text)
            }
        }
        trace("input:type path=system-events length=\(text.count) chunks=\(chunks.count)")
        return true
    }
    trace("input:type path=cgevent length=\(text.count)")
    return simulateUnicodeText(text)
}

func modifierFlags(for tokens: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for token in tokens.map(normalized) {
        switch token {
        case "cmd", "command", "meta":
            flags.insert(.maskCommand)
        case "ctrl", "control":
            flags.insert(.maskControl)
        case "alt", "option":
            flags.insert(.maskAlternate)
        case "shift":
            flags.insert(.maskShift)
        default:
            continue
        }
    }
    return flags
}

func simulateKeyChord(_ keySpec: String) -> Bool {
    let rawParts = keySpec.split(separator: "+").map(String.init)
    guard let keyToken = rawParts.last,
          let keyCode = keyCode(for: keyToken),
          let source = CGEventSource(stateID: .hidSystemState),
          let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
        if rawParts.count == 1 {
            return simulateUnicodeText(keySpec)
        }
        return false
    }

    let flags = modifierFlags(for: Array(rawParts.dropLast()))
    keyDown.flags = flags
    keyUp.flags = flags
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
    return true
}

func postKeyChord(_ keySpec: String, target: AppTarget, raise: Bool = true) -> Bool {
    let rawParts = keySpec.split(separator: "+").map(String.init)
    guard let keyToken = rawParts.last else {
        return false
    }

    let modifiers = Array(rawParts.dropLast())
    if !alwaysSimulateInput(), let keyCode = keyCode(for: keyToken) {
        var command = "key code \(keyCode)"
        if let modifierList = systemEventsModifierList(modifiers) {
            command += " using \(modifierList)"
        }
        if runSystemEventsOnTarget(target, bodyLines: [command], raise: raise) {
            trace("input:key path=system-events key=\(keySpec)")
            return true
        }
    } else if !alwaysSimulateInput(), rawParts.count == 1 {
        if postUnicodeText(keySpec, target: target, raise: raise) {
            return true
        }
    }

    trace("input:key path=cgevent key=\(keySpec)")
    return simulateKeyChord(keySpec)
}

func snapshotCommand(_ options: SnapshotOptions) throws -> SnapshotDocument {
    let target = try resolveTarget(
        pid: options.pid,
        appName: options.appName,
        bundleId: options.bundleId
    )
    configureMessagingTimeout(for: target)
    let builder = SnapshotBuilder(
        maxDepth: options.maxDepth,
        maxNodes: options.maxNodes
    )

    // Snapshot the app's currently relevant window roots. For Electron/CEF
    // hosts, `prepareTargetForAutomation(...)` enables manual accessibility
    // and `axChildren(...)` descends through webview container roles when
    // the app exposes meaningful descendants through the parent AX tree.
    let roots = options.allWindows
        ? allWindowRoots(for: target.axApp)
        : snapshotRoots(for: target.axApp)
    let nodes = roots.enumerated().compactMap { index, root in
        builder.buildNode(
            element: root,
            depth: 0,
            childPath: [index],
            ancestry: [],
            windowTitle: nil
        )
    }

    let windowTitle = nodes.first?.title
    let windowFrame = nodes.first?.frame
    var warnings = builder.warnings

    var screenshot: Screenshot? = nil
    if let screenshotPath = options.screenshotPath {
        let (captured, screenshotWarning) = captureScreenshot(
            to: screenshotPath,
            rect: windowFrame,
            pid: target.app.processIdentifier,
            includeBase64: options.inlineScreenshot
        )
        if let screenshotWarning {
            warnings.append(screenshotWarning)
        }
        screenshot = captured
    }

    let appInstructions = bundleAppInstructions(for: target.app.bundleIdentifier)
    let windowId = resolveOnScreenWindowID(
        pid: target.app.processIdentifier,
        expectedTitle: windowTitle,
        expectedFrame: windowFrame
    )

    let document = SnapshotDocument(
        ok: true,
        appName: target.app.localizedName ?? "Unknown",
        bundleId: target.app.bundleIdentifier,
        pid: target.app.processIdentifier,
        windowTitle: windowTitle,
        windowFrame: windowFrame,
        windowId: windowId,
        nodeCount: builder.currentNodeCount(),
        refCount: builder.refs.count,
        refs: builder.refs,
        indices: builder.indices,
        nodes: nodes,
        warnings: warnings,
        screenshotPath: options.screenshotPath,
        screenshot: screenshot,
        appInstructions: appInstructions,
        capturedAt: isoTimestamp(),
        maxDepth: options.maxDepth,
        maxNodes: options.maxNodes,
        allWindows: options.allWindows
    )

    try writeSnapshotState(document, statePath: options.statePath)
    return document
}

func refreshSnapshotAfterAction(
    statePath: String,
    snapshot: SnapshotDocument?,
    captureScreenshot: Bool,
    inlineScreenshot: Bool
) -> (SnapshotDocument?, [String]) {
    let options = SnapshotOptions(
        pid: snapshot?.pid,
        appName: snapshot?.appName,
        bundleId: snapshot?.bundleId,
        maxDepth: max(1, snapshot?.maxDepth ?? 4),
        maxNodes: max(25, snapshot?.maxNodes ?? 320),
        statePath: statePath,
        screenshotPath: captureScreenshot
            ? (snapshot?.screenshotPath ?? derivedScreenshotPath(for: statePath))
            : nil,
        inlineScreenshot: inlineScreenshot,
        allWindows: snapshot?.allWindows ?? false
    )

    do {
        let refreshed = try snapshotCommand(options)
        var extraWarnings: [String] = []
        // Post-action URL safety: if the refreshed window/focus surfaces a
        // URL on a forbidden host, warn loudly. Cleaning up the side-effect
        // is up to the caller, but we never want to silently leave the
        // session on (e.g.) a banking page after a click.
        if let urlNode = focusedUrlNode(in: refreshed.nodes) {
            let lower = urlNode.lowercased()
            for needle in forbiddenUrlSubstrings() {
                if lower.contains(needle.lowercased()) {
                    extraWarnings.append(
                        "Post-action navigation reached a forbidden URL ('\(needle)' matched). "
                        + "stella-computer will not act further on this surface; switch back manually."
                    )
                }
            }
        }
        return (refreshed, extraWarnings)
    } catch {
        return (
            nil,
            ["Failed to refresh the desktop snapshot after the action: \(error.localizedDescription)"]
        )
    }
}

// Walk a snapshot tree looking for the first URL hint on a focused or
// window-root node. Used by the post-action URL safety re-check.
func focusedUrlNode(in nodes: [SnapshotNode]) -> String? {
    for node in nodes {
        if let url = node.url, !url.isEmpty, (node.focused == true || node.role == kAXWindowRole as String) {
            return url
        }
        if let nested = focusedUrlNode(in: node.children) {
            return nested
        }
    }
    return nil
}

// When --all-windows is requested, snapshot every accessibility window the
// app advertises plus the focused window (deduplicated). This is the only
// way to interact with non-frontmost windows of a multi-window app like
// Finder or Terminal without first having to focus them via a click that
// the model can't reliably target.
func allWindowRoots(for app: AXUIElement) -> [AXUIElement] {
    var roots: [AXUIElement] = []
    let rootBatch = axBatchedAttributes(
        app,
        [
            kAXFocusedWindowAttribute as String,
            kAXWindowsAttribute as String,
            kAXMenuBarAttribute as String,
        ]
    )
    appendUniqueElement(
        coerceElement(rootBatch[kAXFocusedWindowAttribute as String]),
        into: &roots,
        excluding: app
    )
    appendUniqueElements(
        coerceElementArray(rootBatch[kAXWindowsAttribute as String]),
        into: &roots,
        excluding: app
    )
    // Same reason as snapshotRoots: surface the menu bar so background AX
    // actions (e.g. Playback > Play in Spotify) can be driven without raising
    // the target window.
    appendUniqueElement(
        coerceElement(rootBatch[kAXMenuBarAttribute as String]),
        into: &roots,
        excluding: app
    )
    if roots.isEmpty {
        return snapshotRoots(for: app)
    }
    return roots
}

func actionCandidate(
    statePath: String,
    targetId: String
) throws -> (SnapshotDocument, AppTarget, RefEntry, ResolvedCandidate) {
    let snapshot = try loadSnapshotState(from: statePath)
    guard let entry = snapshot.refs[targetId] ?? snapshot.indices?[targetId] else {
        throw failure("Unknown element: \(targetId)")
    }

    // Re-resolve via NSWorkspace first to detect "app died between snapshot
    // and action". If the original pid is gone but the same bundle is still
    // running, transparently rebind to the new instance.
    var target: AppTarget
    if let revalidated = revalidateTarget(snapshot) {
        target = revalidated
        try ensureTargetAllowed(revalidated.app)
        if revalidated.app.processIdentifier != snapshot.pid {
            // Bound to a new pid; previous snapshot positions may be stale.
            // Fall through to the candidate match (which is structural, not
            // pid-bound), but signal with a warning later.
        }
    } else {
        // App is fully gone; produce a clean error.
        throw failure(
            "Target app '\(snapshot.appName)' (pid \(snapshot.pid)) is no longer running. Take a fresh snapshot to continue."
        )
    }
    configureMessagingTimeout(for: target)

    // URL safety: if the snapshot's matched window or focused element
    // resolves to a forbidden URL, block the action.
    if let entryUrl = entry.url, !entryUrl.isEmpty {
        let lower = entryUrl.lowercased()
        for needle in forbiddenUrlSubstrings() {
            if lower.contains(needle.lowercased()) {
                throw failure(
                    "stella-computer is not allowed to operate on '\(needle)'. Set STELLA_COMPUTER_FORBIDDEN_URL_SUBSTRINGS to override (not recommended)."
                )
            }
        }
    }

    AxDiagnostics.shared.reset()
    // Action-time lookup must reach at least as deep as the snapshot did.
    // CEF/Electron wrappers are nested ~30 levels deep before reaching
    // anything actionable; floor at 32 to match the snapshot defaults.
    let lookupDepth = max(snapshot.maxDepth ?? 32, 32)
    let lookupNodes = max((snapshot.maxNodes ?? 1500) * 2, 3000)
    let candidates = collectCandidates(target: target, maxDepth: lookupDepth, maxNodes: lookupNodes)
    let ranked = rankedCandidates(for: entry, in: candidates)
    guard var candidate = bestCandidate(for: entry, ranked: ranked) else {
        if ranked.count > 1 {
            let best = ranked[0]
            let second = ranked[1]
            throw failureWithScreenshot(
                "Ambiguous match for \(targetId) in the current accessibility tree.",
                statePath: statePath,
                target: target,
                warnings: [
                    "Best score: \(best.score); second score: \(second.score).",
                    "Take a fresh snapshot or narrow the target UI before retrying.",
                ] + AxDiagnostics.shared.warnings()
            )
        }
        let oopBundles = oopHostingBundleIdentifierPrefixes
        let bundleId = snapshot.bundleId ?? ""
        let suggestsOOP = oopBundles.contains(where: { bundleId.hasPrefix($0) }) ||
            AxDiagnostics.shared.oopHits > 0
        let extra = suggestsOOP
            ? ["Target hosts UI in helper processes; some elements may be invisible to AX. Consider stella-browser for web content."]
            : []
        throw failureWithScreenshot(
            "Failed to resolve \(targetId) in the current accessibility tree.",
            statePath: statePath,
            target: target,
            warnings: extra + AxDiagnostics.shared.warnings()
        )
    }
    // Append OOP diagnostics to the resolved candidate's warnings.
    let oopWarnings = AxDiagnostics.shared.warnings()
    if !oopWarnings.isEmpty {
        candidate = ResolvedCandidate(
            candidate: candidate.candidate,
            score: candidate.score,
            warnings: candidate.warnings + oopWarnings
        )
    }
    return (snapshot, target, entry, candidate)
}

func parseNamedOption(_ args: [String], key: String) -> String? {
    if let index = args.firstIndex(of: key), index + 1 < args.count {
        return args[index + 1]
    }
    if let inline = args.first(where: { $0.hasPrefix("\(key)=") }) {
        return String(inline.dropFirst(key.count + 1))
    }
    return nil
}

func hasFlag(_ args: [String], key: String) -> Bool {
    args.contains(key)
}

func isHidAllowed(_ args: [String]) -> Bool {
    if hasFlag(args, key: "--allow-hid") {
        return true
    }
    guard let rawValue = ProcessInfo.processInfo.environment["STELLA_COMPUTER_ALLOW_HID"]?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased() else {
        return false
    }
    return rawValue == "1" || rawValue == "true" || rawValue == "yes"
}

func snapshotOptions(from args: [String]) throws -> SnapshotOptions {
    guard let statePath = parseNamedOption(args, key: "--state") else {
        throw NSError(domain: "desktop_automation", code: 4, userInfo: [
            NSLocalizedDescriptionKey: "--state is required for snapshot."
        ])
    }
    let pidValue = parseNamedOption(args, key: "--pid").flatMap(Int32.init)
    let appName = parseNamedOption(args, key: "--app")
    let bundleId = parseNamedOption(args, key: "--bundle-id")
    // Depth/node defaults are driven by CEF/Electron worst case. Spotify
    // wraps the actual content in 9-12 nested empty `AXGroup` containers
    // before reaching the search field or track row, then needs another
    // 6-10 levels inside the row itself. Discord, Slack, Notion, Cursor,
    // VS Code, and any other Electron app are similar. AppKit-native apps
    // never come close to these depths so the only cost is a slightly
    // larger snapshot for them; on the other hand, getting these too low
    // for CEF means the snapshot stops before reaching anything actionable.
    let maxDepth = parseNamedOption(args, key: "--max-depth").flatMap(Int.init) ?? 32
    let maxNodes = parseNamedOption(args, key: "--max-nodes").flatMap(Int.init) ?? 1500
    let screenshotPath = hasFlag(args, key: "--no-screenshot")
        ? nil
        : parseNamedOption(args, key: "--screenshot") ?? derivedScreenshotPath(for: statePath)
    let inlineScreenshot = !hasFlag(args, key: "--no-inline-screenshot")
        && !envBool("STELLA_COMPUTER_NO_INLINE_SCREENSHOT")
    let allWindows = hasFlag(args, key: "--all-windows")
    return SnapshotOptions(
        pid: pidValue,
        appName: appName,
        bundleId: bundleId,
        maxDepth: max(1, maxDepth),
        maxNodes: max(25, maxNodes),
        statePath: statePath,
        screenshotPath: screenshotPath,
        inlineScreenshot: inlineScreenshot,
        allWindows: allWindows
    )
}

func actionOptions(from args: [String]) throws -> ActionOptions {
    guard let statePath = parseNamedOption(args, key: "--state") else {
        throw NSError(domain: "desktop_automation", code: 5, userInfo: [
            NSLocalizedDescriptionKey: "--state is required."
        ])
    }
    let inlineScreenshot = !hasFlag(args, key: "--no-inline-screenshot")
        && !envBool("STELLA_COMPUTER_NO_INLINE_SCREENSHOT")
    // Visual overlay (software cursor only) is on by default; agent-driven
    // sessions get the visible "Stella is acting on this element" feedback.
    // Pass `--no-overlay` (or set STELLA_COMPUTER_NO_OVERLAY=1) to disable
    // when chained-action latency matters more than visual feedback.
    let showOverlay = !hasFlag(args, key: "--no-overlay")
        && !envBool("STELLA_COMPUTER_NO_OVERLAY")
    // Default is no-raise. Opt in via --raise or STELLA_COMPUTER_RAISE=1.
    // --no-raise is accepted as a no-op for back-compat with older callers.
    let raise = hasFlag(args, key: "--raise") || envBool("STELLA_COMPUTER_RAISE")
    return ActionOptions(
        statePath: statePath,
        coordinateFallback: hasFlag(args, key: "--coordinate-fallback"),
        allowHid: isHidAllowed(args),
        captureScreenshot: !hasFlag(args, key: "--no-screenshot"),
        raise: raise,
        inlineScreenshot: inlineScreenshot,
        showOverlay: showOverlay
    )
}

func positionalArguments(_ args: [String]) -> [String] {
    var results: [String] = []
    var index = 0
    while index < args.count {
        let current = args[index]
        if current.hasPrefix("--") {
            if current.contains("=") {
                index += 1
                continue
            }
            if index + 1 < args.count, !args[index + 1].hasPrefix("--") {
                index += 2
            } else {
                index += 1
            }
            continue
        }
        results.append(current)
        index += 1
    }
    return results
}

func stateContext(for statePath: String) -> (SnapshotDocument?, AppTarget?) {
    let snapshot = tryLoadSnapshotState(from: statePath)
    let target = try? resolveTarget(
        pid: snapshot?.pid,
        appName: snapshot?.appName,
        bundleId: snapshot?.bundleId
    )
    if let target {
        configureMessagingTimeout(for: target)
    }
    return (snapshot, target)
}

func actionSuccessPayload(
    action: String,
    ref: String?,
    message: String,
    matchedRef: String?,
    usedAction: String?,
    warnings: [String],
    refreshedSnapshot: SnapshotDocument?
) -> ActionPayload {
    ActionPayload(
        ok: true,
        action: action,
        ref: ref,
        message: message,
        matchedRef: matchedRef,
        usedAction: usedAction,
        warnings: warnings,
        screenshotPath: refreshedSnapshot?.screenshotPath,
        screenshot: refreshedSnapshot?.screenshot,
        appInstructions: refreshedSnapshot?.appInstructions,
        snapshotText: nil
    )
}

func executeCommandInternal(args: [String]) throws -> CommandExecutionResult {
    guard let command = args.first else {
        throw NSError(domain: "desktop_automation", code: 6, userInfo: [
            NSLocalizedDescriptionKey: "Missing command."
        ])
    }
    let commandArgs = Array(args.dropFirst())

    // `list-apps` is pure NSWorkspace + LaunchServices and does not need a
    // WindowServer connection, so it short-circuits before the bootstrap.
    if command == "list-apps" {
        return commandResult(listAppsCommand())
    }

    // Every other command touches a GUI-bound API: ScreenCaptureKit (used
    // by `snapshot`), NSBitmapImageRep, NSPanel, NSScreen, the action
    // overlay, NSDraggingSession. All of those assert inside
    // `CGS_REQUIRE_INIT` if the process hasn't first promoted its
    // activation policy, called `finishLaunching`, and spun the run-loop
    // once to let SkyLight finish the handshake. This is the same
    // bootstrap Codex Computer Use's service does at LSApplicationCheckIn
    // time — it never operates in a degraded "no graphical session" mode,
    // and neither do we. Surface a clean error envelope if the host has
    // no WindowServer session at all (headless ssh, non-user launchd
    // job, etc.) so the model gets a directly actionable message instead
    // of a process-killing CG assertion.
    guard tryBootstrapAppKit() else {
        return commandResult(
            ErrorPayload(
                ok: false,
                error:
                    "stella-computer requires a graphical (WindowServer) session. "
                    + "Run from a logged-in macOS user context that has Accessibility "
                    + "and Screen Recording permission for this binary.",
                warnings: [],
                screenshot: nil,
                screenshotPath: nil
            ),
            code: 1
        )
    }

    guard AXIsProcessTrusted() else {
        return commandResult(
            ErrorPayload(
                ok: false,
                error: "Accessibility permission is required for desktop automation.",
                warnings: [],
                screenshot: nil,
                screenshotPath: nil
            ),
            code: 1
        )
    }

    switch command {
    case "snapshot":
        let options = try snapshotOptions(from: commandArgs)
        return commandResult(try snapshotCommand(options))
    case "click":
        let options = try actionOptions(from: commandArgs)
        let positional = positionalArguments(commandArgs)
        guard let ref = positional.first else {
            throw NSError(domain: "desktop_automation", code: 7, userInfo: [
                NSLocalizedDescriptionKey: "click requires a ref."
            ])
        }
        if options.coordinateFallback && !options.allowHid {
            throw NSError(domain: "desktop_automation", code: 8, userInfo: [
                NSLocalizedDescriptionKey:
                    "click --coordinate-fallback requires --allow-hid or STELLA_COMPUTER_ALLOW_HID=1."
            ])
        }
        let (snapshot, target, _, resolved) = try actionCandidate(statePath: options.statePath, targetId: ref)
        let (clicked, usedAction) = withUnifiedActionOverlay(
            enabled: overlayEnabled(options),
            statePath: options.statePath,
            snapshot: snapshot,
            target: target,
            frame: resolved.candidate.frame,
            interactionKind: "click"
        ) {
            performClick(
                candidate: resolved.candidate,
                target: target,
                coordinateFallback: options.coordinateFallback && options.allowHid,
                raise: options.raise
            )
        }
        guard clicked else {
            throw failureWithScreenshot(
                "Failed to click \(ref).",
                statePath: options.statePath,
                target: target,
                candidate: resolved.candidate,
                warnings: resolved.warnings,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        var warnings = resolved.warnings
        if usedAction == "coordinate-fallback" {
            warnings.append("Coordinate-targeted click can interfere with active user input.")
        }
        let (refreshedSnapshot, refreshWarnings) = refreshSnapshotAfterAction(
            statePath: options.statePath,
            snapshot: snapshot,
            captureScreenshot: options.captureScreenshot,
            inlineScreenshot: options.inlineScreenshot
        )
        warnings.append(contentsOf: refreshWarnings)
        return commandResult(
            actionSuccessPayload(
                action: "click",
                ref: ref,
                message: "Clicked \(ref).",
                matchedRef: ref,
                usedAction: usedAction,
                warnings: warnings,
                refreshedSnapshot: refreshedSnapshot
            )
        )
    case "fill":
        let options = try actionOptions(from: commandArgs)
        let positional = positionalArguments(commandArgs)
        guard positional.count >= 2 else {
            throw NSError(domain: "desktop_automation", code: 9, userInfo: [
                NSLocalizedDescriptionKey: "fill requires a ref and text."
            ])
        }
        let ref = positional[0]
        let text = positional[1]
        let (snapshot, target, _, resolved) = try actionCandidate(statePath: options.statePath, targetId: ref)
        let (filled, fillUsedAction) = withUnifiedActionOverlay(
            enabled: overlayEnabled(options),
            statePath: options.statePath,
            snapshot: snapshot,
            target: target,
            frame: resolved.candidate.frame,
            interactionKind: "fill"
        ) {
            setValue(
                candidate: resolved.candidate,
                text: text,
                target: target,
                raise: options.raise
            )
        }
        guard filled else {
            throw failureWithScreenshot(
                "Failed to set value for \(ref).",
                statePath: options.statePath,
                target: target,
                candidate: resolved.candidate,
                warnings: resolved.warnings,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        var warnings = resolved.warnings
        if fillUsedAction == "keystroke" {
            warnings.append("AXValue rejected by element; fell back to keystroke fill.")
        }
        let (refreshedSnapshot, refreshWarnings) = refreshSnapshotAfterAction(
            statePath: options.statePath,
            snapshot: snapshot,
            captureScreenshot: options.captureScreenshot,
            inlineScreenshot: options.inlineScreenshot
        )
        warnings.append(contentsOf: refreshWarnings)
        return commandResult(
            actionSuccessPayload(
                action: "fill",
                ref: ref,
                message: "Updated \(ref).",
                matchedRef: ref,
                usedAction: fillUsedAction ?? "AXValue",
                warnings: warnings,
                refreshedSnapshot: refreshedSnapshot
            )
        )
    case "focus":
        let options = try actionOptions(from: commandArgs)
        let positional = positionalArguments(commandArgs)
        guard let ref = positional.first else {
            throw NSError(domain: "desktop_automation", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "focus requires a ref."
            ])
        }
        let (snapshot, target, _, resolved) = try actionCandidate(statePath: options.statePath, targetId: ref)
        let focusOk = withUnifiedActionOverlay(
            enabled: overlayEnabled(options),
            statePath: options.statePath,
            snapshot: snapshot,
            target: target,
            frame: resolved.candidate.frame,
            interactionKind: "focus"
        ) {
            setFocused(resolved.candidate.element)
        }
        guard focusOk else {
            throw failureWithScreenshot(
                "Failed to focus \(ref).",
                statePath: options.statePath,
                target: target,
                candidate: resolved.candidate,
                warnings: resolved.warnings,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        var warnings = resolved.warnings
        let (refreshedSnapshot, refreshWarnings) = refreshSnapshotAfterAction(
            statePath: options.statePath,
            snapshot: snapshot,
            captureScreenshot: options.captureScreenshot,
            inlineScreenshot: options.inlineScreenshot
        )
        warnings.append(contentsOf: refreshWarnings)
        return commandResult(
            actionSuccessPayload(
                action: "focus",
                ref: ref,
                message: "Focused \(ref).",
                matchedRef: ref,
                usedAction: "AXFocused",
                warnings: warnings,
                refreshedSnapshot: refreshedSnapshot
            )
        )
    case "secondary-action", "perform-secondary-action":
        let options = try actionOptions(from: commandArgs)
        let positional = positionalArguments(commandArgs)
        guard positional.count >= 2 else {
            throw NSError(domain: "desktop_automation", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "secondary-action requires a ref and action name."
            ])
        }
        let ref = positional[0]
        let actionName = positional[1]
        let (snapshot, target, _, resolved) = try actionCandidate(statePath: options.statePath, targetId: ref)
        guard let resolvedActionName = resolveActionName(actionName, from: resolved.candidate.actions) else {
            var warnings = resolved.warnings
            if !resolved.candidate.actions.isEmpty {
                warnings.append("Available actions: \(resolved.candidate.actions.joined(separator: ", "))")
            }
            throw failureWithScreenshot(
                "Action \(actionName) is not available for \(ref).",
                statePath: options.statePath,
                target: target,
                candidate: resolved.candidate,
                warnings: warnings,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        let secondaryOk = withUnifiedActionOverlay(
            enabled: overlayEnabled(options),
            statePath: options.statePath,
            snapshot: snapshot,
            target: target,
            frame: resolved.candidate.frame,
            interactionKind: command
        ) {
            performSemanticAction(candidate: resolved.candidate, actionName: resolvedActionName)
        }
        guard secondaryOk else {
            throw failureWithScreenshot(
                "Failed to perform \(resolvedActionName) on \(ref).",
                statePath: options.statePath,
                target: target,
                candidate: resolved.candidate,
                warnings: resolved.warnings,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        var warnings = resolved.warnings
        let (refreshedSnapshot, refreshWarnings) = refreshSnapshotAfterAction(
            statePath: options.statePath,
            snapshot: snapshot,
            captureScreenshot: options.captureScreenshot,
            inlineScreenshot: options.inlineScreenshot
        )
        warnings.append(contentsOf: refreshWarnings)
        return commandResult(
            actionSuccessPayload(
                action: "secondary-action",
                ref: ref,
                message: "Performed \(resolvedActionName) on \(ref).",
                matchedRef: ref,
                usedAction: resolvedActionName,
                warnings: warnings,
                refreshedSnapshot: refreshedSnapshot
            )
        )
    case "scroll":
        let options = try actionOptions(from: commandArgs)
        let positional = positionalArguments(commandArgs)
        guard positional.count >= 2 else {
            throw NSError(domain: "desktop_automation", code: 21, userInfo: [
                NSLocalizedDescriptionKey: "scroll requires a ref and direction."
            ])
        }
        let ref = positional[0]
        let direction = positional[1]
        let pages = max(1, parseNamedOption(commandArgs, key: "--pages").flatMap(Int.init) ?? 1)
        guard scrollActionName(for: direction) != nil else {
            throw NSError(domain: "desktop_automation", code: 22, userInfo: [
                NSLocalizedDescriptionKey: "scroll direction must be up, down, left, or right."
            ])
        }
        let (snapshot, target, _, resolved) = try actionCandidate(statePath: options.statePath, targetId: ref)
        let scrollResult = withUnifiedActionOverlay(
            enabled: overlayEnabled(options),
            statePath: options.statePath,
            snapshot: snapshot,
            target: target,
            frame: resolved.candidate.frame,
            interactionKind: "scroll"
        ) {
            performScroll(
                candidate: resolved.candidate,
                direction: direction,
                pages: pages
            )
        }
        guard let (usedAction, scrollWarnings) = scrollResult else {
            var warnings = resolved.warnings
            if !resolved.candidate.actions.isEmpty {
                warnings.append("Available actions: \(resolved.candidate.actions.joined(separator: ", "))")
            }
            throw failureWithScreenshot(
                "Failed to scroll \(ref) \(direction).",
                statePath: options.statePath,
                target: target,
                candidate: resolved.candidate,
                warnings: warnings,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        var warnings = resolved.warnings
        warnings.append(contentsOf: scrollWarnings)
        let (refreshedSnapshot, refreshWarnings) = refreshSnapshotAfterAction(
            statePath: options.statePath,
            snapshot: snapshot,
            captureScreenshot: options.captureScreenshot,
            inlineScreenshot: options.inlineScreenshot
        )
        warnings.append(contentsOf: refreshWarnings)
        let pageSummary = pages == 1 ? "1 page" : "\(pages) pages"
        return commandResult(
            actionSuccessPayload(
                action: "scroll",
                ref: ref,
                message: "Scrolled \(ref) \(normalized(direction)) by \(pageSummary).",
                matchedRef: ref,
                usedAction: usedAction,
                warnings: warnings,
                refreshedSnapshot: refreshedSnapshot
            )
        )
    case "click-point":
        let options = try actionOptions(from: commandArgs)
        guard options.allowHid else {
            throw NSError(domain: "desktop_automation", code: 12, userInfo: [
                NSLocalizedDescriptionKey:
                    "click-point requires --allow-hid or STELLA_COMPUTER_ALLOW_HID=1."
            ])
        }
        let positional = positionalArguments(commandArgs)
        guard positional.count >= 2,
              let x = Double(positional[0]),
              let y = Double(positional[1]) else {
            throw NSError(domain: "desktop_automation", code: 13, userInfo: [
                NSLocalizedDescriptionKey: "click-point requires x and y."
            ])
        }
        let (snapshot, target) = stateContext(for: options.statePath)
        guard let target else {
            throw failure("click-point requires a valid target app context.")
        }
        let point = CGPoint(x: x, y: y)
        let clicked = withUnifiedActionOverlay(
            enabled: overlayEnabled(options),
            statePath: options.statePath,
            snapshot: snapshot,
            target: target,
            frame: nil,
            cursorPoint: point,
            interactionKind: "click-point"
        ) {
            postLeftClick(at: point, target: target, raise: options.raise)
        }
        guard clicked else {
            throw failureWithScreenshot(
                "Failed to send pointer click.",
                statePath: options.statePath,
                target: target,
                warnings: ["Global click injection can interfere with active user input."],
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        var warnings = ["Global click injection can interfere with active user input."]
        let (refreshedSnapshot, refreshWarnings) = refreshSnapshotAfterAction(
            statePath: options.statePath,
            snapshot: snapshot,
            captureScreenshot: options.captureScreenshot,
            inlineScreenshot: options.inlineScreenshot
        )
        warnings.append(contentsOf: refreshWarnings)
        return commandResult(
            actionSuccessPayload(
                action: "click-point",
                ref: nil,
                message: "Clicked point (\(x), \(y)).",
                matchedRef: nil,
                usedAction: "coordinate",
                warnings: warnings,
                refreshedSnapshot: refreshedSnapshot
            )
        )
    case "drag":
        let options = try actionOptions(from: commandArgs)
        guard options.allowHid else {
            throw NSError(domain: "desktop_automation", code: 23, userInfo: [
                NSLocalizedDescriptionKey:
                    "drag requires --allow-hid or STELLA_COMPUTER_ALLOW_HID=1."
            ])
        }
        let positional = positionalArguments(commandArgs)
        guard positional.count >= 4,
              let fromX = Double(positional[0]),
              let fromY = Double(positional[1]),
              let toX = Double(positional[2]),
              let toY = Double(positional[3]) else {
            throw NSError(domain: "desktop_automation", code: 24, userInfo: [
                NSLocalizedDescriptionKey: "drag requires from_x, from_y, to_x, and to_y."
            ])
        }
        let (snapshot, target) = stateContext(for: options.statePath)
        guard let target else {
            throw failure("drag requires a valid target app context.")
        }
        guard simulateDrag(
            from: CGPoint(x: fromX, y: fromY),
            to: CGPoint(x: toX, y: toY)
        ) else {
            throw failureWithScreenshot(
                "Failed to send pointer drag.",
                statePath: options.statePath,
                target: target,
                warnings: [
                    "Drag currently uses global pointer injection and can interfere with active user input."
                ],
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        var warnings = [
            "Drag currently uses global pointer injection and can interfere with active user input."
        ]
        let (refreshedSnapshot, refreshWarnings) = refreshSnapshotAfterAction(
            statePath: options.statePath,
            snapshot: snapshot,
            captureScreenshot: options.captureScreenshot,
            inlineScreenshot: options.inlineScreenshot
        )
        warnings.append(contentsOf: refreshWarnings)
        return commandResult(
            actionSuccessPayload(
                action: "drag",
                ref: nil,
                message: "Dragged pointer from (\(fromX), \(fromY)) to (\(toX), \(toY)).",
                matchedRef: nil,
                usedAction: "drag",
                warnings: warnings,
                refreshedSnapshot: refreshedSnapshot
            )
        )
    case "drag-element":
        // Codex-style content drag: source identified by a ref, destination
        // by either another ref or x/y coords. Uses NSDraggingSession so the
        // destination app sees a real drag-and-drop with proper pasteboard
        // types, not synthesized mouse events at the destination view.
        let options = try actionOptions(from: commandArgs)
        guard options.allowHid else {
            throw NSError(domain: "desktop_automation", code: 41, userInfo: [
                NSLocalizedDescriptionKey:
                    "drag-element requires --allow-hid or STELLA_COMPUTER_ALLOW_HID=1 because it moves the user's cursor."
            ])
        }
        let positional = positionalArguments(commandArgs)
        guard let sourceRef = positional.first else {
            throw NSError(domain: "desktop_automation", code: 42, userInfo: [
                NSLocalizedDescriptionKey: "drag-element requires a source ref."
            ])
        }
        let dragType = parseNamedOption(commandArgs, key: "--type")
        let opMask = parseDragOperation(parseNamedOption(commandArgs, key: "--operation"))

        let (snapshot, target, _, sourceResolved) = try actionCandidate(
            statePath: options.statePath,
            targetId: sourceRef
        )
        guard let sourceFrame = sourceResolved.candidate.frame else {
            throw failureWithScreenshot(
                "Source ref \(sourceRef) has no frame; cannot drag from it.",
                statePath: options.statePath,
                target: target,
                candidate: sourceResolved.candidate,
                warnings: sourceResolved.warnings,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        let fromPoint = frameCenter(sourceFrame)

        // Destination: either positional ref / coords, or --to-ref / --to-x --to-y.
        var toPoint: CGPoint? = nil
        var destDescription = ""
        if positional.count >= 3,
           let toX = Double(positional[1]),
           let toY = Double(positional[2]) {
            toPoint = CGPoint(x: toX, y: toY)
            destDescription = "(\(toX), \(toY))"
        } else if positional.count >= 2 {
            // Treat positional[1] as a destination ref.
            let destRef = positional[1]
            let (_, _, _, destResolved) = try actionCandidate(
                statePath: options.statePath,
                targetId: destRef
            )
            guard let destFrame = destResolved.candidate.frame else {
                throw failureWithScreenshot(
                    "Destination ref \(destRef) has no frame; cannot drag to it.",
                    statePath: options.statePath,
                    target: target,
                    candidate: destResolved.candidate,
                    warnings: destResolved.warnings,
                    captureDiagnosticScreenshot: options.captureScreenshot
                )
            }
            toPoint = frameCenter(destFrame)
            destDescription = destRef
        } else if let toRef = parseNamedOption(commandArgs, key: "--to-ref") {
            let (_, _, _, destResolved) = try actionCandidate(
                statePath: options.statePath,
                targetId: toRef
            )
            guard let destFrame = destResolved.candidate.frame else {
                throw failureWithScreenshot(
                    "Destination ref \(toRef) has no frame; cannot drag to it.",
                    statePath: options.statePath,
                    target: target,
                    candidate: destResolved.candidate,
                    warnings: destResolved.warnings,
                    captureDiagnosticScreenshot: options.captureScreenshot
                )
            }
            toPoint = frameCenter(destFrame)
            destDescription = toRef
        } else if let toX = parseNamedOption(commandArgs, key: "--to-x").flatMap(Double.init),
                  let toY = parseNamedOption(commandArgs, key: "--to-y").flatMap(Double.init) {
            toPoint = CGPoint(x: toX, y: toY)
            destDescription = "(\(toX), \(toY))"
        }

        guard let toPoint else {
            throw NSError(domain: "desktop_automation", code: 43, userInfo: [
                NSLocalizedDescriptionKey:
                    "drag-element requires a destination: pass another ref, two coords (x y), or --to-ref / --to-x --to-y."
            ])
        }

        guard let (items, usedKind) = pasteboardItemsForCandidate(
            sourceResolved.candidate,
            explicitType: dragType
        ) else {
            throw failureWithScreenshot(
                "drag-element could not extract a pasteboard payload from \(sourceRef). The element exposes no AXURL or text value to drag. Use the raw `drag` command for coordinate-only drags.",
                statePath: options.statePath,
                target: target,
                candidate: sourceResolved.candidate,
                warnings: sourceResolved.warnings,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }

        let (ok, dragErr) = performNSDragSession(
            items: items,
            fromScreen: fromPoint,
            toScreen: toPoint,
            operation: opMask
        )
        if !ok {
            throw failureWithScreenshot(
                "NSDraggingSession from \(sourceRef) to \(destDescription) failed: \(dragErr ?? "unknown error").",
                statePath: options.statePath,
                target: target,
                candidate: sourceResolved.candidate,
                warnings: sourceResolved.warnings,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        var warnings = sourceResolved.warnings
        warnings.append("Content drag uses real NSDraggingSession: the destination app sees a typed drop, but the user's cursor does move during the drag.")
        let (refreshedSnapshot, refreshWarnings) = refreshSnapshotAfterAction(
            statePath: options.statePath,
            snapshot: snapshot,
            captureScreenshot: options.captureScreenshot,
            inlineScreenshot: options.inlineScreenshot
        )
        warnings.append(contentsOf: refreshWarnings)
        return commandResult(
            actionSuccessPayload(
                action: "drag-element",
                ref: sourceRef,
                message: "Dragged \(sourceRef) (\(usedKind)) to \(destDescription).",
                matchedRef: sourceRef,
                usedAction: "NSDraggingSession:\(usedKind)",
                warnings: warnings,
                refreshedSnapshot: refreshedSnapshot
            )
        )
    case "type":
        let options = try actionOptions(from: commandArgs)
        guard options.allowHid else {
            throw NSError(domain: "desktop_automation", code: 14, userInfo: [
                NSLocalizedDescriptionKey:
                    "type requires --allow-hid or STELLA_COMPUTER_ALLOW_HID=1."
            ])
        }
        let positional = positionalArguments(commandArgs)
        guard let text = positional.first else {
            throw NSError(domain: "desktop_automation", code: 15, userInfo: [
                NSLocalizedDescriptionKey: "type requires text."
            ])
        }
        let (snapshot, target) = stateContext(for: options.statePath)
        guard let target else {
            throw failure("type requires a valid target app context.")
        }
        guard postUnicodeText(text, target: target, raise: options.raise) else {
            throw failureWithScreenshot(
                "Failed to type text.",
                statePath: options.statePath,
                target: target,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        var warnings = ["Typed input goes to the currently focused element."]
        let (refreshedSnapshot, refreshWarnings) = refreshSnapshotAfterAction(
            statePath: options.statePath,
            snapshot: snapshot,
            captureScreenshot: options.captureScreenshot,
            inlineScreenshot: options.inlineScreenshot
        )
        warnings.append(contentsOf: refreshWarnings)
        return commandResult(
            actionSuccessPayload(
                action: "type",
                ref: nil,
                message: "Typed text.",
                matchedRef: nil,
                usedAction: "unicode",
                warnings: warnings,
                refreshedSnapshot: refreshedSnapshot
            )
        )
    case "press":
        let options = try actionOptions(from: commandArgs)
        guard options.allowHid else {
            throw NSError(domain: "desktop_automation", code: 16, userInfo: [
                NSLocalizedDescriptionKey:
                    "press requires --allow-hid or STELLA_COMPUTER_ALLOW_HID=1."
            ])
        }
        let positional = positionalArguments(commandArgs)
        guard let keySpec = positional.first else {
            throw NSError(domain: "desktop_automation", code: 17, userInfo: [
                NSLocalizedDescriptionKey: "press requires a key."
            ])
        }
        let (snapshot, target) = stateContext(for: options.statePath)
        guard let target else {
            throw failure("press requires a valid target app context.")
        }
        guard postKeyChord(keySpec, target: target, raise: options.raise) else {
            throw failureWithScreenshot(
                "Failed to send key press.",
                statePath: options.statePath,
                target: target,
                captureDiagnosticScreenshot: options.captureScreenshot
            )
        }
        var warnings = ["Key presses go to the currently focused app."]
        let (refreshedSnapshot, refreshWarnings) = refreshSnapshotAfterAction(
            statePath: options.statePath,
            snapshot: snapshot,
            captureScreenshot: options.captureScreenshot,
            inlineScreenshot: options.inlineScreenshot
        )
        warnings.append(contentsOf: refreshWarnings)
        return commandResult(
            actionSuccessPayload(
                action: "press",
                ref: nil,
                message: "Sent key press \(keySpec).",
                matchedRef: nil,
                usedAction: keySpec,
                warnings: warnings,
                refreshedSnapshot: refreshedSnapshot
            )
        )
    default:
        throw NSError(domain: "desktop_automation", code: 19, userInfo: [
            NSLocalizedDescriptionKey: "Unknown command: \(command)"
        ])
    }
}

func executeCommand(args: [String]) -> CommandExecutionResult {
    do {
        return try executeCommandInternal(args: args)
    } catch let failure as DesktopAutomationFailure {
        return commandResult(
            ErrorPayload(
                ok: false,
                error: failure.message,
                warnings: failure.warnings,
                screenshot: failure.screenshot,
                screenshotPath: failure.screenshotPath
            ),
            code: 1
        )
    } catch {
        return commandResult(
            ErrorPayload(
                ok: false,
                error: error.localizedDescription,
                warnings: [],
                screenshot: nil,
                screenshotPath: nil
            ),
            code: 1
        )
    }
}

struct AutomationDaemonOptions {
    let socketPath: String
    let pidFile: String
}

func automationDaemonOptions(from args: [String]) throws -> AutomationDaemonOptions {
    guard let socketPath = parseNamedOption(args, key: "--socket-path"),
          let pidFile = parseNamedOption(args, key: "--pid-file") else {
        throw NSError(domain: "desktop_automation_daemon", code: 1, userInfo: [
            NSLocalizedDescriptionKey:
                "desktop_automation daemon requires --socket-path and --pid-file."
        ])
    }
    return AutomationDaemonOptions(
        socketPath: socketPath,
        pidFile: pidFile
    )
}

func writeTextAtomic(_ text: String, to path: String) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true,
        attributes: nil
    )
    guard let data = text.data(using: .utf8) else {
        throw NSError(domain: "desktop_automation_daemon", code: 4, userInfo: [
            NSLocalizedDescriptionKey: "Failed to encode daemon file contents."
        ])
    }
    try data.write(to: url, options: .atomic)
}

func withDaemonRequestEnvironment(
    _ env: [String: String],
    body: () -> CommandExecutionResult
) -> CommandExecutionResult {
    let scopedKeys = Array(Set(daemonScopedEnvironmentKeys).union(env.keys))
    var previousValues: [String: String?] = [:]
    for key in scopedKeys {
        previousValues[key] = ProcessInfo.processInfo.environment[key]
        unsetenv(key)
    }
    for (key, value) in env {
        setenv(key, value, 1)
    }
    let result = body()
    for key in scopedKeys {
        if let previous = previousValues[key] {
            if let previous {
                setenv(key, previous, 1)
            } else {
                unsetenv(key)
            }
        } else {
            unsetenv(key)
        }
    }
    return result
}

final class AutomationDaemon {
    private let options: AutomationDaemonOptions
    private let serverQueue = DispatchQueue(label: "desktop_automation.daemon.server")
    private var listeningFD: Int32 = -1

    init(options: AutomationDaemonOptions) {
        self.options = options
    }

    func start() throws -> Never {
        guard tryBootstrapAppKit() else {
            throw NSError(domain: "desktop_automation_daemon", code: 2, userInfo: [
                NSLocalizedDescriptionKey:
                    "desktop_automation daemon requires a graphical (WindowServer) session."
            ])
        }
        guard AXIsProcessTrusted() else {
            throw NSError(domain: "desktop_automation_daemon", code: 3, userInfo: [
                NSLocalizedDescriptionKey:
                    "Accessibility permission is required for the desktop_automation daemon."
            ])
        }

        signal(SIGPIPE, SIG_IGN)
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: options.socketPath).deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: nil
        )
        try? FileManager.default.removeItem(atPath: options.socketPath)
        try writeTextAtomic(String(ProcessInfo.processInfo.processIdentifier), to: options.pidFile)
        let overlayBusyUntilPath = URL(fileURLWithPath: options.pidFile)
            .deletingLastPathComponent()
            .appendingPathComponent("overlay-busy-until.json")
            .path
        let overlayService = UnifiedAutomationOverlayService(busyUntilPath: overlayBusyUntilPath)
        overlayService.start()
        currentAutomationOverlayService = overlayService
        listeningFD = try makeListeningSocket(at: options.socketPath)
        serverQueue.async { [weak self] in
            self?.acceptLoop()
        }
        while true {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.25))
        }
    }

    private func acceptLoop() {
        while true {
            let clientFD = accept(listeningFD, nil, nil)
            if clientFD < 0 {
                if errno == EINTR {
                    continue
                }
                fputs("desktop_automation daemon accept failed: \(String(cString: strerror(errno)))\n", stderr)
                continue
            }
            handleClient(clientFD)
        }
    }

    private func handleClient(_ clientFD: Int32) {
        defer {
            close(clientFD)
        }

        guard let requestData = readSocketData(from: clientFD) else {
            return
        }

        let decoder = JSONDecoder()
        guard let request = try? decoder.decode(AutomationDaemonRequest.self, from: requestData) else {
            let response = AutomationDaemonResponse(
                seq: 0,
                status: 1,
                stdout: "{\"ok\":false,\"error\":\"invalid daemon request\"}",
                stderr: ""
            )
            _ = writeSocketData(encodedResponseData(for: response), to: clientFD)
            return
        }

        let result = executeDaemonRequest(request)
        let response = AutomationDaemonResponse(
            seq: request.seq,
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr
        )
        _ = writeSocketData(encodedResponseData(for: response), to: clientFD)
    }

    private func executeDaemonRequest(_ request: AutomationDaemonRequest) -> CommandExecutionResult {
        if request.argv.first == "daemon" {
            return commandResult(
                ErrorPayload(
                    ok: false,
                    error: "desktop_automation daemon cannot execute nested daemon commands.",
                    warnings: [],
                    screenshot: nil,
                    screenshotPath: nil
                ),
                code: 1
            )
        }

        let semaphore = DispatchSemaphore(value: 0)
        var result = commandResult(
            ErrorPayload(
                ok: false,
                error: "desktop_automation daemon failed to execute request.",
                warnings: [],
                screenshot: nil,
                screenshotPath: nil
            ),
            code: 1
        )

        DispatchQueue.main.async {
            result = withDaemonRequestEnvironment(request.env ?? [:]) {
                executeCommand(args: request.argv)
            }
            semaphore.signal()
        }

        semaphore.wait()
        return result
    }
}

func encodedResponseData(for response: AutomationDaemonResponse) -> Data {
    if let text = try? encodedJson(response) {
        return Data(text.utf8)
    }
    return Data("{\"seq\":0,\"status\":1,\"stdout\":\"\",\"stderr\":\"failed to encode daemon response\"}".utf8)
}

func readSocketData(from fd: Int32) -> Data? {
    var data = Data()
    var byte: UInt8 = 0
    while true {
        let count = read(fd, &byte, 1)
        if count > 0 {
            if byte == 0x0A {
                return data
            }
            data.append(&byte, count: 1)
            continue
        }
        if count == 0 {
            return data.isEmpty ? nil : data
        }
        if errno == EINTR {
            continue
        }
        return nil
    }
}

func writeSocketData(_ data: Data, to fd: Int32) -> Bool {
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    do {
        try handle.write(contentsOf: data)
        return true
    } catch {
        return false
    }
}

func makeListeningSocket(at path: String) throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else {
        throw NSError(domain: "desktop_automation_daemon", code: 5, userInfo: [
            NSLocalizedDescriptionKey: "Failed to create daemon socket."
        ])
    }

    var address = sockaddr_un()
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    address.sun_family = sa_family_t(AF_UNIX)
    let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
    let utf8Path = path.utf8CString
    guard utf8Path.count <= maxPathLength else {
        close(fd)
        throw NSError(domain: "desktop_automation_daemon", code: 6, userInfo: [
            NSLocalizedDescriptionKey: "Daemon socket path is too long."
        ])
    }

    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        let buffer = UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self)
        buffer.initialize(repeating: 0, count: maxPathLength)
        _ = utf8Path.withUnsafeBufferPointer { chars in
            strncpy(buffer, chars.baseAddress, maxPathLength - 1)
        }
    }

    let addressLength = socklen_t(address.sun_len)
    let bindResult = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, addressLength)
        }
    }
    guard bindResult == 0 else {
        let message = String(cString: strerror(errno))
        close(fd)
        throw NSError(domain: "desktop_automation_daemon", code: 7, userInfo: [
            NSLocalizedDescriptionKey: "Failed to bind daemon socket: \(message)"
        ])
    }

    guard listen(fd, SOMAXCONN) == 0 else {
        let message = String(cString: strerror(errno))
        close(fd)
        throw NSError(domain: "desktop_automation_daemon", code: 8, userInfo: [
            NSLocalizedDescriptionKey: "Failed to listen on daemon socket: \(message)"
        ])
    }

    return fd
}

let cliArgs = Array(CommandLine.arguments.dropFirst())
if cliArgs.first == "daemon" {
    do {
        let daemon = AutomationDaemon(options: try automationDaemonOptions(from: Array(cliArgs.dropFirst())))
        try daemon.start()
    } catch {
        fputs("desktop_automation daemon failed to start: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

emitCommandResult(executeCommand(args: cliArgs))
