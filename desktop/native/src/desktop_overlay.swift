import AppKit
import CoreGraphics
import Foundation
import QuartzCore

struct Rect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Point: Codable {
    let x: Double
    let y: Double
}

struct OverlayCommand: Codable {
    let seq: Int
    let action: String
    let frame: Rect?
    let viewportFrame: Rect?
    let cursorPoint: Point?
    let interactionKind: String?
    // Prefer the exact target CGWindowID when Stella has one. This mirrors
    // Codex's `aboveWindowID` API. The pid/title fields remain as a fallback
    // in case the window ID went stale between snapshot and render.
    let targetWindowId: UInt32?
    let targetPid: Int?
    let targetBundleId: String?
    let targetWindowTitle: String?
}

let overlayFadeOutDuration: TimeInterval = 0.18

// Cursor motion model — direct port of the Codex Computer Use overlay
// pipeline reverse-engineered out of `SkyComputerUseService` (symbols
// recovered: BezierAnimation, BezierFunction, CursorMotionPath,
// CursorMotionPathMeasurement, _animatedAngleOffsetDegrees,
// maxAngleChange, _angle, atan2, DisplayLinkAnimationDriver,
// DynamicPropertyAnimator). The shape:
//
//   * Each move computes one cubic Bezier in 2D space from the current
//     cursor position to the destination. Control points are placed
//     along the launch and arrival tangents.
//   * A scalar BezierFunction shapes the timing curve (default ease-in-
//     ease-out). It maps wall-clock progress t ∈ [0,1] to a path
//     parameter u ∈ [0,1].
//   * Each frame the cursor's `position` is `path.point(at: u)` and its
//     rotation tracks `atan2(path.tangent(at: u))` clamped per-frame by
//     `overlayCursorMaxAngleRateRadPerSec` so sharp turns don't snap.
//   * Chained moves carry the previous arrival tangent forward as the
//     next move's launch tangent, so the heading is continuous between
//     hops.
let overlayCursorMoveDuration: TimeInterval = 0.85
let overlayCursorMinPathDistance: CGFloat = 6
// Resting tilt (radians). With our heading convention (rotation 0 = the
// sprite points straight up, positive rotation rotates clockwise), a small
// positive value gives the natural macOS arrow pose: pointing up and
// leaning slightly to the right.
let overlayCursorBaseRotation: CGFloat = 0.18
// Distance the launch / arrival control points sit out along their
// respective tangents, expressed as a fraction of move length. 0.42 ≈
// the same handle factor we observed in our prior implementation; this
// keeps a clear arc on long moves without ballooning short ones.
let overlayCursorPathOutHandleFactor: CGFloat = 0.42
let overlayCursorPathInHandleFactor: CGFloat = 0.42
// `BezierFunction` timing curve. Codex uses standard easing presets;
// ease-in-ease-out is what their "Bezier cursor animation" defaults to
// and produces the slow-start, slow-stop arrival the user expects.
let overlayCursorTimingControl1: CGPoint = CGPoint(x: 0.42, y: 0.0)
let overlayCursorTimingControl2: CGPoint = CGPoint(x: 0.58, y: 1.0)
// Cap on how fast the rendered cursor sprite can rotate. Without this,
// a hard tangent change near the start or end of the path would snap
// the sprite. Rough Codex feel: ~3π rad/s.
let overlayCursorMaxAngleRateRadPerSec: CGFloat = 9.5
// How much of the previous move's arrival tangent magnitude carries
// forward as the next move's launch handle. 1 = full continuity. 0 =
// each move starts from rest. Codex-style: full continuity, otherwise
// the arc looks "reset" between hops.
let overlayCursorTangentCarryoverFraction: CGFloat = 1.0
// Cursor style state recovered from Codex:
//  - shared style state: velocityX, velocityY, isPressed, activityState,
//    isAttached, angle
//  - explicit activity enum: idle, loading, paused
//  - extra fog/software style state: _animatedAngleOffsetDegrees,
//    _loadingAnimationToken, cursorScaleAnchorPoint
//
// We model that as a small loading wiggle on the rendered angle plus a
// tip-anchored press pulse for click-like interactions.
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

// Snake-style tail rendered as a separate CAShapeLayer attached to the
// cursor's tail anchor (midpoint of the head's base). The tail is drawn
// in the cursor's local coordinate space so it inherits the head's
// rotation transform automatically; the wiggle is applied by perturbing
// the tail path's control points each tick.
//
// Coordinates here are in the same local space as `softwareCursorImage()`
// (origin = bottom-left of the sprite canvas, y up). The "anchor" is the
// point on the head's base where the tail attaches; the "tip" is the very
// end of the tail.
let overlayCursorTailAnchor = CGPoint(x: 15, y: 14)
let overlayCursorTailLength: CGFloat = 16.0
let overlayCursorTailBaseWidth: CGFloat = 6.4
let overlayCursorTailTipWidth: CGFloat = 0.7
let overlayCursorTailSegmentCount = 14
// Wiggle amplitudes are in the tail's local lateral direction
// (perpendicular to its mean axis). A small base wiggle is always
// present so the tail reads as alive even when the cursor is parked.
let overlayCursorTailIdleWiggleAmplitude: CGFloat = 1.6
let overlayCursorTailMoveWiggleAmplitude: CGFloat = 3.4
let overlayCursorTailWiggleFrequencyHz: CGFloat = 1.55
// Wave number along the tail (how many half-waves fit across the tail's
// length). ~1.4 reads as one slow side-to-side flick rather than a sine
// wave running down the tail.
let overlayCursorTailWaveNumber: CGFloat = 1.35
// Resting bend of the tail's mean axis (radians). 0 = the tail extends
// straight along the cursor's axis (centered behind the head). Any
// non-zero value would offset the tail to one side; we keep this at 0
// so the cursor reads as symmetric.
let overlayCursorTailRestingCurl: CGFloat = 0.0

private var appKitBootstrapped = false
private var appKitBootstrapFailed = false
private var cachedSoftwareCursorImage: NSImage?

func logLine(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

func tryBootstrapAppKit() -> Bool {
    if appKitBootstrapped { return true }
    if appKitBootstrapFailed { return false }
    guard let _ = CGSessionCopyCurrentDictionary() as Dictionary? else {
        appKitBootstrapFailed = true
        return false
    }
    let app = NSApplication.shared
    if app.activationPolicy() != .accessory {
        _ = app.setActivationPolicy(.accessory)
    }
    app.finishLaunching()
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
    appKitBootstrapped = true
    return true
}

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
        // The Codex Computer Use service positions its overlay window
        // by direct z-order with `orderWindow(.above, relativeTo:
        // <targetCGWindowID>)` rather than parking it at a high
        // floating level. WindowServer then handles all of the "this
        // window is in front of the target app, so it should also be
        // in front of the overlay" clipping automatically — no
        // per-frame layer mask needed. To make that work we leave the
        // panel at the normal window level and let `orderWindow:
        // relativeTo:` push it into the right slot in the stack.
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

final class OverlayHostView: NSView {
    override var isFlipped: Bool { false }
    override func mouseDown(with event: NSEvent) { }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { false }
}

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

func rectToCGRect(_ rect: Rect) -> CGRect {
    CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
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

func screenContaining(point: CGPoint) -> NSScreen? {
    for screen in NSScreen.screens {
        if topLeftFrame(for: screen).contains(point) { return screen }
    }
    return nil
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

// Real macOS pointer location in AX/CG top-left coordinates.
// `CGEvent(source: nil)?.location` returns global pointer position with
// y measured from the top of the primary display, which matches the
// coordinate space everything else in the daemon uses (AX windowFrame,
// CGWindowListCopyWindowInfo bounds, etc.).
func mouseLocationInAXCoordinates(screen _: NSScreen) -> CGPoint {
    if let event = CGEvent(source: nil) {
        return event.location
    }
    // Fall back to AppKit if the event source is unavailable for some
    // reason. NSEvent.mouseLocation is in AppKit screen coords (y from
    // bottom), so flip it onto the AX top-left axis using the primary
    // display's height.
    let appKit = NSEvent.mouseLocation
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
    return CGPoint(x: appKit.x, y: primaryHeight - appKit.y)
}

// Clamp `point` so it sits at least `inset` pixels inside `rect`. Used
// to keep the cursor spawn point inside the viewport so the host's
// `masksToBounds = true` doesn't immediately clip the first frame.
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

// Identity used to find the on-screen window the overlay is supposed to
// shadow. Prefer a direct CGWindowID from snapshot-time resolution; fall
// back to pid/title/frame matching if that ID is stale.
struct OverlayTargetIdentity: Equatable {
    let targetWindowID: CGWindowID?
    let pid: pid_t
    let bundleId: String?
    let windowTitle: String?
    let viewportFrame: CGRect
}

// One on-screen window (in CG / AX top-left coordinates) sitting at a
// given z-order index. Lower index == higher in the stack (closer to the
// user). This is the same convention `CGWindowListCopyWindowInfo` uses
// when called with `.optionOnScreenOnly`.
struct WindowEntry {
    let windowID: CGWindowID
    let pid: pid_t
    let frame: CGRect
    let title: String?
    let layer: Int
}

// Pull every on-screen window above the dock/desktop, in front-to-back
// order, with their AX-style top-left frames.
func enumerateOnScreenWindows() -> [WindowEntry] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    return raw.compactMap { entry -> WindowEntry? in
        guard let windowID = (entry[kCGWindowNumber as String] as? CGWindowID) ?? nil,
              let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat],
              let pidNumber = entry[kCGWindowOwnerPID as String] as? Int else {
            return nil
        }
        let layer = entry[kCGWindowLayer as String] as? Int ?? 0
        // Skip system layers (menu bar, dock, status items). Normal app
        // windows live at layer 0; transient panels can be slightly
        // above. Anything with a high layer (e.g. cursor, screen shield)
        // would never visually occlude a regular app window in a way the
        // user perceives, so we exclude them from the occluder set.
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

// Best-effort match of the AX target window (which we know by pid +
// title + frame) against the list of on-screen windows. We score by:
//  - same pid (required)
//  - exact title match (strong signal, optional because some apps
//    don't expose AX titles to CG)
//  - frame overlap area (largest wins)
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

// Helpers ---------------------------------------------------------------

// Heading convention used everywhere in this file:
//
//   * The overlay window/host view is **non-flipped** AppKit space (origin
//     bottom-left, y increases upward).
//   * `overlayLocalPoint(fromAXPoint:viewportFrame:)` already converts from
//     AX top-left coordinates into that bottom-left space, so dx/dy in the
//     steering loop are real AppKit-local deltas with y pointing UP.
//   * `softwareCursorImage()` draws the sprite with its tip at the
//     **top-left** of the bitmap. With anchorPoint (0, 1) the tip sits at
//     the layer's `position`, and at rotation 0 the cursor visually points
//     up-and-slightly-right (the natural "default" arrow).
//
// Under that convention, "rotation 0 = pointing up", so converting an
// AppKit-local heading vector (dx right, dy up) into the layer's rotation
// is `atan2(dx, dy)`. Previously this used `atan2(dx, -dy)`, which
// corresponded to a flipped/top-left coord system and produced a near-180°
// inversion against the actual local space — that's why the cursor pointed
// almost the opposite way.
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

// Inverse of `rotationForHeading`: takes a layer rotation and returns the
// unit heading vector in the same AppKit-local (y-up) space the steering
// loop operates in. Must stay consistent with `rotationForHeading`,
// otherwise position and rotation drift in opposite directions.
func headingVector(for rotation: CGFloat) -> CGPoint {
    CGPoint(x: sin(rotation), y: cos(rotation))
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

// 1D scalar timing function. Numerically inverts a cubic Bezier in the
// unit square defined by (0,0), control1, control2, (1,1) — same
// semantics as `CAMediaTimingFunction(controlPoints:)`. This is a port
// of the `BezierFunction(initWithControlPoints::::)` symbol observed in
// the Codex Computer Use binary.
struct BezierFunction {
    let c1: CGPoint
    let c2: CGPoint

    static let easeInEaseOut = BezierFunction(c1: CGPoint(x: 0.42, y: 0.0), c2: CGPoint(x: 0.58, y: 1.0))

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
        // Solve x(t) = p for t, then return y(t).
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

// 2D cubic Bezier path with derivative sampling. This is the
// `CursorMotionPath` / `CursorMotionPathMeasurement` recovered from the
// Codex binary. Position(at:) and tangent(at:) are evaluated directly
// from the four control points — there is no precomputed CGPath, no
// arc-length re-parameterization; the rendered motion is whatever the
// timing function decides + the spatial path's natural parameterization.
struct CursorMotionPath {
    let start: CGPoint
    let controlOut: CGPoint
    let controlIn: CGPoint
    let end: CGPoint

    static func make(start: CGPoint,
                     end: CGPoint,
                     launchTangent: CGPoint,
                     arrivalTangent: CGPoint,
                     outHandleFactor: CGFloat,
                     inHandleFactor: CGFloat) -> CursorMotionPath {
        let distance = hypot(end.x - start.x, end.y - start.y)
        let outLen = distance * outHandleFactor
        let inLen = distance * inHandleFactor
        let unitLaunch = normalized(launchTangent)
        let unitArrival = normalized(arrivalTangent)
        let controlOut = addPoints(start, scalePoint(unitLaunch, by: outLen))
        // arrivalTangent points in the direction the cursor is moving as
        // it reaches `end`, so the inbound control point sits *behind*
        // `end` along that direction.
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

    // First derivative of the cubic Bezier — the direction the cursor
    // is moving at parameter `u`. Not unit length; callers normalize as
    // needed.
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
    let m = hypot(v.x, v.y)
    if m == 0 { return CGPoint(x: 0, y: 1) }
    return CGPoint(x: v.x / m, y: v.y / m)
}

// Linear interpolation between two unit vectors; result re-normalized.
// `weight = 0` returns `a`, `weight = 1` returns `b`.
func blendUnitVectors(_ a: CGPoint, _ b: CGPoint, weight: CGFloat) -> CGPoint {
    let w = max(0, min(1, weight))
    let mixed = CGPoint(x: a.x * (1 - w) + b.x * w, y: a.y * (1 - w) + b.y * w)
    return normalized(mixed)
}

final class PersistentOverlayController {
    // Path the daemon writes its current "busy until" wall-clock
    // timestamp to. Read by the wrapper so it can pace consecutive
    // actions: don't fire the next mouse action until the previous
    // arc has actually finished animating. Source of truth is the
    // daemon, not the wrapper, because the daemon is the only thing
    // that knows the real per-move duration.
    private let busyUntilPath: String
    private var window: ActionOverlayWindow?
    private var cursorLayer: CALayer?
    // Tail rendering uses two cooperating layers so it can match the
    // head's silver gradient finish:
    //   * `tailGradient` is a `CAGradientLayer` that paints the
    //     white→silver fill across the tail's bounding region.
    //   * `tailGradientMask` is a `CAShapeLayer` whose path is the
    //     tail outline; it's set as `tailGradient.mask` so the
    //     gradient only shows inside the tail silhouette.
    //   * `tailStroke` is a separate `CAShapeLayer` drawn on top of
    //     the gradient that paints the dark outline (Core Animation
    //     gradients can't stroke a path on their own, so we add a
    //     stroke-only shape layer above the gradient with the same
    //     path).
    // All three live as sublayers of the cursor container, so they
    // inherit rotation, scale, position, and shadow from the head.
    private var tailGradient: CAGradientLayer?
    private var tailGradientMask: CAShapeLayer?
    private var tailStroke: CAShapeLayer?
    private var currentScreen: NSScreen?
    private var currentViewportFrame: CGRect?
    private var currentTargetIdentity: OverlayTargetIdentity?
    private var currentInteractionKind: String?
    // Window number we last asked WindowServer to slot the overlay
    // panel above. Tracked so we don't churn `orderWindow:relativeTo:`
    // every tick when the target z-order is stable.
    private var lastOrderedAboveWindowID: CGWindowID?
    // Tracks whether the target window was on-screen as of the previous
    // `refreshOverlayWindowOrdering()` tick. Used to debounce
    // `orderOut`/`orderFrontRegardless` calls — we only flip the
    // overlay's visibility when the underlying state actually changes,
    // not every frame. nil = unknown (just spawned).
    private var lastTargetOnScreen: Bool?
    private var animationFinishesAt: CFTimeInterval = 0
    private var pendingShow: (viewportFrame: CGRect, cursorPoint: CGPoint)?
    private var currentPosition: CGPoint?
    // Active spatial path + timing curve + start time. nil = idle.
    private var activePath: CursorMotionPath?
    private var activeTiming: BezierFunction = .easeInEaseOut
    private var activeStartTime: CFTimeInterval = 0
    private var activeDuration: TimeInterval = overlayCursorMoveDuration
    // Tangent (unit vector) the cursor was moving in at the end of the
    // previous move. Carried into the next move so heading is continuous
    // between hops. nil before any move has run.
    private var lastArrivalTangent: CGPoint?
    // Rendered angle of the sprite. Updated each tick from the path
    // tangent, rate-limited by overlayCursorMaxAngleRateRadPerSec.
    private var renderedAngle: CGFloat = overlayCursorBaseRotation
    private var idleAnimationStartedAt: CFTimeInterval?
    private var clickPulseStartedAt: CFTimeInterval?
    private var shouldTriggerClickPulse = false
    private var didTriggerClickPulseForMove = false
    private var lastTickAt: CFTimeInterval?

    init(busyUntilPath: String) {
        self.busyUntilPath = busyUntilPath
    }

    // Publish two wall-clock deadlines for the wrapper to pace against:
    //
    //   * `busyUntilMs` — the cursor's full animation window. The wrapper
    //     waits on this before scheduling the *next* `show` command, so
    //     consecutive arcs never overlap.
    //
    //   * `actionReadyAtMs` — the moment the cursor satisfies Codex's
    //     `nextInteractionTiming.closeEnough` predicate. For click-like
    //     interactions, the wrapper releases the actual HID dispatch as
    //     soon as this deadline passes, which makes the real click land
    //     visually in sync with the press pulse instead of after the full
    //     move + pulse completes. For non-click interactions this is
    //     equal to `busyUntilMs` (no early release).
    //
    // Both are absolute wall-clock milliseconds since the unix epoch so
    // the wrapper can compare against `Date.now()` directly.
    private func writeBusyUntil(remainingSeconds: TimeInterval, actionReadyInSeconds: TimeInterval? = nil) {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let busyUntilMs = nowMs + max(0, remainingSeconds) * 1000
        let actionReadyAtMs = nowMs + max(0, min(remainingSeconds, actionReadyInSeconds ?? remainingSeconds)) * 1000
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
        guard let targetScreen = screenContaining(point: viewportCenter) ?? screenContaining(point: cursorPoint) ?? NSScreen.main else { return }

        currentTargetIdentity = targetIdentity
        currentInteractionKind = interactionKind

        // First-time / viewport change always rebuilds; that's a hard
        // cut, not a curve, so we can do it immediately. After the
        // rebuild, the cursor sits at the spawn position — fall
        // through to setTarget below so the very first action animates
        // *to* the click point instead of teleporting onto it.
        if window == nil || currentScreen !== targetScreen || currentViewportFrame != viewportFrame {
            rebuildWindow(screen: targetScreen, viewportFrame: viewportFrame, cursorPoint: cursorPoint)
            refreshOverlayWindowOrdering()
            // No early return — fall through to setTarget so the first
            // move actually animates from the spawn position.
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
        // Re-issue the overlay's z-order placement each tick. If the
        // user clicks another app and brings it to the front, that app
        // moves above the target window in the WindowServer stack, and
        // because we slot the overlay relative to the target window
        // it'll move with it. Cheap operation: just compares window IDs
        // and only calls `orderWindow:relativeTo:` when the target's
        // ID actually changed.
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
            // Idle/loading: keep the base rendered angle, but layer on the
            // small Codex-style loading wiggle and any active click pulse.
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
            if progress >= overlayCursorClickCloseEnoughProgress || remainingDistance <= overlayCursorClickCloseEnoughDistance {
                didTriggerClickPulseForMove = true
                startClickPulseIfNeeded(at: now)
                clickScale = clickPulseScale(at: now)
                // The wrapper is sleeping on `actionReadyAtMs`. Re-publish
                // it as "right now" so the real HID dispatch fires this
                // tick instead of at the predicted closeEnough time
                // (which can be a frame or two late if the wrapper saw
                // an empty file the first time around).
                let totalRemaining = max(0, animationFinishesAt - now)
                writeBusyUntil(remainingSeconds: totalRemaining, actionReadyInSeconds: 0)
            }
        }

        currentPosition = nextPosition
        renderedAngle = newAngle
        applyCursorState(cursor, position: nextPosition, rotation: newAngle, scale: clickScale)
        updateTailPath(at: now, hasActivePath: true)

        // End-of-move bookkeeping.
        if progress >= 1 {
            // Capture the arrival tangent so the next move launches in
            // the same direction (visual continuity between hops).
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
        win.orderOut(nil)
        window = nil
        cursorLayer = nil
        tailGradient = nil
        tailGradientMask = nil
        tailStroke = nil
        currentScreen = nil
        currentViewportFrame = nil
        currentTargetIdentity = nil
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

    private func rebuildWindow(screen: NSScreen, viewportFrame: CGRect, cursorPoint: CGPoint) {
        hideImmediate(preservingTargetIdentity: true)
        let winFrame = appKitFrame(fromAXRect: viewportFrame, screen: screen)
        let win = ActionOverlayWindow(frame: winFrame)
        let hostBounds = NSRect(origin: .zero, size: winFrame.size)
        let host = OverlayHostView(frame: hostBounds)
        host.wantsLayer = true
        host.layer?.backgroundColor = .clear
        // Spawn fully opaque so the first move is visible immediately.
        host.layer?.opacity = 1
        // Codex's overlay relies on z-ordering with `orderWindow(.above,
        // relativeTo: targetCGWindowID)` for occlusion against other
        // windows. We still keep host-layer clipping turned on so any
        // sublayer can't paint outside our own host bounds, but we no
        // longer compute a per-frame visibility mask — WindowServer
        // handles that automatically once the panel is ordered relative
        // to the target window.
        host.layer?.masksToBounds = true
        win.contentView = host

        // Spawn the cursor at the real macOS pointer's current location,
        // mapped into the host's local coordinate space. This keeps the
        // first move easier to track than a fixed viewport-center spawn:
        //   1. The user's eye is already there, so the first move is
        //      always visible (no "where did it appear?" frame).
        //   2. The move's launch direction is naturally correct
        //      because it starts where the user was just looking.
        let mouseAX = mouseLocationInAXCoordinates(screen: screen)
        // Clamp the spawn point to the viewport so we never start the
        // first arc outside the host's drawable bounds.
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
        self.window = win
        self.currentScreen = screen
        self.currentViewportFrame = viewportFrame
        // Slot the overlay panel into the window stack right above the
        // target app's window. This is the same approach Codex's
        // SkyComputerUseService takes (recovered symbol:
        // `move(to:aboveWindowID:relativeToWindow:nextInteractionTiming:
        // animated:fadeIn:isDelegate:)`). After this, anything that's
        // ordered in front of the target window is also in front of the
        // overlay automatically — no per-frame layer mask needed.
        refreshOverlayWindowOrdering()
        host.layer?.displayIfNeeded()
        win.displayIfNeeded()
        CATransaction.flush()
    }

    // Place the overlay panel directly above the target app's window in
    // the WindowServer z-order, so any window currently in front of the
    // target also stays in front of the overlay. This is the trick the
    // Codex Computer Use service uses (its method signature is
    // `move(to:aboveWindowID:relativeToWindow:nextInteractionTiming:
    // animated:fadeIn:isDelegate:)`); we don't have to compute or
    // maintain any visibility mask because WindowServer handles
    // occlusion for us once the overlay is parked at the right slot in
    // the stack.
    //
    // We also use this same on-screen lookup to gate the overlay's
    // visibility. macOS's NSPanel collection-behavior alone isn't enough
    // to confine the overlay to a single Space (Mission Control desktop):
    // a `.fullScreenAuxiliary`-style panel will follow the user across
    // Spaces even though its target app window stayed behind. Instead of
    // fighting collection-behavior, we just check whether the target
    // CGWindowID is currently in the on-screen window list (which
    // excludes other Spaces, minimized windows, hidden apps, and closed
    // windows) and order the panel out when it isn't. When the target
    // comes back on-screen we order the panel back in and re-slot it
    // above the target.
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
                // Force a full re-order next time the target reappears,
                // since `orderOut` drops our slot in the stack.
                lastOrderedAboveWindowID = nil
            }
        }
        guard let match = match else { return }
        let targetWindowID = match.entry.windowID
        // Always re-issue the ordering call. `order(.above, relativeTo:)`
        // is a one-time placement; macOS does NOT keep our window glued
        // above the target. If anything else changes the WindowServer
        // stack (any other window briefly comes forward, the user clicks
        // a different app, a Spotlight-style panel opens, etc.) our
        // overlay falls below it and stays there until we re-order.
        // Re-ordering is cheap (no-op if we're already in the right slot).
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

        // Launch tangent: prefer the previous move's arrival tangent
        // (continuity), falling back to the straight-line direction to
        // the target on the very first move so the cursor doesn't sit
        // perpendicular to its destination at startup.
        let straightTangent = normalized(CGPoint(x: dest.x - start.x, y: dest.y - start.y))
        let launchTangent: CGPoint
        if let last = lastArrivalTangent, distance >= overlayCursorMinPathDistance {
            launchTangent = blendUnitVectors(last, straightTangent, weight: 1 - overlayCursorTangentCarryoverFraction)
        } else {
            launchTangent = straightTangent
        }
        // Arrival tangent is the straight-line direction to the target.
        // Codex-style cursor lands aimed at the click point.
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
        // Scale duration mildly with distance so short hops don't take a
        // full second. Clamped to a reasonable range.
        let baseDuration = overlayCursorMoveDuration
        let scaled = baseDuration * Double(min(1.0, max(0.45, distance / 600.0)))
        activeDuration = scaled
        let clickTail = shouldTriggerClickPulse ? overlayCursorClickPulseDuration : 0
        scheduleAnimationFinish(extraTail: clickTail)
        // Tell the wrapper how long this move will take. We add a small
        // safety margin so the wrapper waits until the press pulse is
        // visually done before kicking off the next mouse action.
        let totalRemaining = activeDuration + clickTail + 0.06
        // Predicted "close enough" deadline: the moment the cursor's
        // path progress crosses `overlayCursorClickCloseEnoughProgress`.
        // For click-like moves this is when the wrapper is allowed to
        // dispatch the real HID action so it lands in sync with the
        // visible press pulse. For non-click moves it equals
        // `totalRemaining` (no early release).
        let actionReady: TimeInterval
        if shouldTriggerClickPulse {
            actionReady = activeDuration * Double(overlayCursorClickCloseEnoughProgress)
        } else {
            actionReady = totalRemaining
        }
        writeBusyUntil(remainingSeconds: totalRemaining, actionReadyInSeconds: actionReady)
    }

    private func makeCursorLayer(at point: CGPoint, viewportFrame: CGRect, screen: NSScreen) -> CALayer {
        let img = softwareCursorImage()
        let container = CALayer()
        container.contentsScale = screen.backingScaleFactor
        container.bounds = CGRect(origin: .zero, size: img.size)
        // Anchor on the cursor tip so rotation pivots around the tip
        // rather than the sprite's center, which keeps the visible action
        // point stable while the cursor rotates between targets. The
        // symmetric isoceles head puts the tip at the top center of the
        // 30x38 sprite (15, 36).
        container.anchorPoint = CGPoint(x: 0.5, y: 36.0 / 38.0)
        container.position = overlayLocalPoint(fromAXPoint: point, viewportFrame: viewportFrame)
        setCursorTransform(container, rotation: overlayCursorBaseRotation, scale: 1)
        container.shadowColor = NSColor.black.cgColor
        container.shadowOpacity = 0.35
        container.shadowRadius = 4
        container.shadowOffset = CGSize(width: 0, height: -1)

        // Build the tail in three cooperating sublayers so it matches
        // the head's silver gradient finish and dark outline. See the
        // field declarations on PersistentOverlayController for the
        // architecture.
        let initialPath = tailPath(phase: 0, amplitude: overlayCursorTailIdleWiggleAmplitude)

        let gradient = CAGradientLayer()
        gradient.contentsScale = screen.backingScaleFactor
        gradient.frame = container.bounds
        gradient.colors = [
            NSColor(calibratedWhite: 1, alpha: 0.98).cgColor,
            NSColor(calibratedRed: 0.82, green: 0.85, blue: 0.89, alpha: 0.98).cgColor,
        ]
        // Top-down gradient so the silver shading falls along the tail's
        // length, matching the head's vertical gradient direction
        // (bright at the top of the head, darker toward the tail tip).
        gradient.startPoint = CGPoint(x: 0.5, y: 1)
        gradient.endPoint = CGPoint(x: 0.5, y: 0)

        // Mask layer is configured to NOT clip to its bounds so the
        // tail path can extend below `container.bounds.minY` (the tail
        // intentionally hangs below the head's base).
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

    // Build the tail's path in the cursor's local sprite coordinates.
    // The tail starts at `overlayCursorTailAnchor` (the rear of the head
    // wedge), curls along the resting axis, and tapers from
    // `overlayCursorTailBaseWidth` at the anchor to
    // `overlayCursorTailTipWidth` at the very end.
    //
    // `phase` is the running wiggle phase (radians) and `amplitude` is
    // the lateral wiggle magnitude in points. The wiggle is multiplied by
    // a smooth ramp that's 0 at the base (so the tail meets the head
    // cleanly) and 1 toward the tip (so the tip whips the most), like a
    // real tail.
    private func tailPath(phase: CGFloat, amplitude: CGFloat) -> CGPath {
        let segments = max(4, overlayCursorTailSegmentCount)
        let length = overlayCursorTailLength
        let curl = overlayCursorTailRestingCurl
        let waveK = overlayCursorTailWaveNumber * .pi
        // Mean tail axis (unit vector). Heading convention: cursor rotation 0
        // points "up" in sprite space, so the resting tail points "down-left"
        // relative to the head — i.e. roughly (-sin(curl), -1 - small).
        // We compute centerline points along an arc parameterised by s in
        // [0, 1], curving by `curl` total radians from base to tip.
        var centerline: [CGPoint] = []
        var lateralBasis: [CGPoint] = []
        for i in 0...segments {
            let s = CGFloat(i) / CGFloat(segments)
            let bend = curl * s
            let dir = CGPoint(x: -sin(bend), y: -cos(bend))
            // Integrate position along the centerline. Coarse Euler is fine
            // here; the tail is short and the bend is small.
            let prev = centerline.last ?? overlayCursorTailAnchor
            let step = length / CGFloat(segments)
            let next = i == 0 ? overlayCursorTailAnchor : CGPoint(x: prev.x + dir.x * step, y: prev.y + dir.y * step)
            centerline.append(next)
            // Lateral basis: 90° clockwise from the local direction.
            lateralBasis.append(CGPoint(x: -dir.y, y: dir.x))
        }
        // Lateral offset per segment: sine wave along s with a
        // tip-weighted ramp. The +0.18 keeps a tiny base wiggle so the
        // joint with the head doesn't look perfectly rigid.
        var lateral: [CGFloat] = []
        for i in 0...segments {
            let s = CGFloat(i) / CGFloat(segments)
            let ramp = 0.18 + 0.82 * s * s
            let wave = sin(phase + s * waveK)
            lateral.append(amplitude * ramp * wave)
        }
        // Width per segment, tapering linearly from base to tip.
        var halfWidths: [CGFloat] = []
        for i in 0...segments {
            let s = CGFloat(i) / CGFloat(segments)
            let w = overlayCursorTailBaseWidth + (overlayCursorTailTipWidth - overlayCursorTailBaseWidth) * s
            halfWidths.append(w * 0.5)
        }
        // Build outer (left) and inner (right) edge points.
        var leftEdge: [CGPoint] = []
        var rightEdge: [CGPoint] = []
        for i in 0...segments {
            let c = centerline[i]
            let lat = lateralBasis[i]
            let off = lateral[i]
            let hw = halfWidths[i]
            let centerOffset = CGPoint(x: c.x + lat.x * off, y: c.y + lat.y * off)
            leftEdge.append(CGPoint(x: centerOffset.x + lat.x * hw, y: centerOffset.y + lat.y * hw))
            rightEdge.append(CGPoint(x: centerOffset.x - lat.x * hw, y: centerOffset.y - lat.y * hw))
        }
        // Stitch left edge forward, then right edge in reverse, smoothing
        // with quadratic curves through midpoints for an organic look.
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
        // Round tail tip: arc from last left to last right via centerline tip.
        let tip = centerline.last!
        let lastRight = rightEdge.last!
        let tipDir = lateralBasis.last!
        let beyondTip = CGPoint(x: tip.x - tipDir.y * overlayCursorTailTipWidth * 0.6,
                                y: tip.y + tipDir.x * overlayCursorTailTipWidth * 0.6)
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
        // Anchor phase to the absolute media clock so the tail's wiggle
        // is continuous regardless of which mode the cursor is in
        // (moving, idle, or click-pulsing). The amplitude is what tells
        // the user whether we're in an "alert" move state vs a relaxed
        // idle state — the rhythm itself never stops.
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

    private func applyCursorState(_ cursor: CALayer, position: CGPoint, rotation: CGFloat, scale: CGFloat = 1) {
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

final class OverlayDaemon {
    private let commandFile: String
    private let pidFile: String
    private let controller: PersistentOverlayController
    private var lastSeq = -1
    private var lastActivity = Date()
    private var timer: Timer?

    init(commandFile: String, pidFile: String) {
        self.commandFile = commandFile
        self.pidFile = pidFile
        let busyUntilPath = URL(fileURLWithPath: pidFile)
            .deletingLastPathComponent()
            .appendingPathComponent("overlay-busy-until.json")
            .path
        self.controller = PersistentOverlayController(
            busyUntilPath: busyUntilPath
        )
    }

    func run() {
        writePidFile()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.current.run()
    }

    private func tick() {
        processCommand()
        controller.tick()
        controller.tickPendingShow()
        if Date().timeIntervalSince(lastActivity) > overlayIdleTimeout {
            shutdown()
        }
    }

    private func processCommand() {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: commandFile)) else {
            return
        }
        guard let command = try? JSONDecoder().decode(OverlayCommand.self, from: data) else {
            return
        }
        guard command.seq > lastSeq else { return }
        lastSeq = command.seq
        lastActivity = Date()
        switch command.action {
        case "show":
            guard let frame = command.frame else { return }
            let cgFrame = rectToCGRect(frame)
            let viewportFrame = rectToCGRect(command.viewportFrame ?? frame)
            let cursorPoint = command.cursorPoint.map { CGPoint(x: $0.x, y: $0.y) }
                ?? CGPoint(x: cgFrame.midX, y: cgFrame.midY)
            let identity = command.targetPid.map { pid in
                OverlayTargetIdentity(
                    targetWindowID: command.targetWindowId,
                    pid: pid_t(pid),
                    bundleId: command.targetBundleId,
                    windowTitle: command.targetWindowTitle,
                    viewportFrame: viewportFrame
                )
            }
            controller.showOrMove(
                frame: cgFrame,
                viewportFrame: viewportFrame,
                cursorAt: cursorPoint,
                targetIdentity: identity,
                interactionKind: command.interactionKind
            )
        case "hide":
            controller.hide()
        case "close":
            shutdown()
        default:
            return
        }
    }

    private func writePidFile() {
        let dir = URL(fileURLWithPath: pidFile).deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? String(getpid()).write(toFile: pidFile, atomically: true, encoding: .utf8)
    }

    private func shutdown() {
        controller.hide()
        timer?.invalidate()
        try? FileManager.default.removeItem(atPath: pidFile)
        exit(0)
    }
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

let args = Array(CommandLine.arguments.dropFirst())
guard let commandFile = parseNamedOption(args, key: "--command-file"),
      let pidFile = parseNamedOption(args, key: "--pid-file") else {
    logLine("desktop_overlay requires --command-file and --pid-file")
    exit(1)
}

guard tryBootstrapAppKit() else {
    logLine("desktop_overlay requires a graphical WindowServer session")
    exit(1)
}

let daemon = OverlayDaemon(commandFile: commandFile, pidFile: pidFile)
daemon.run()
