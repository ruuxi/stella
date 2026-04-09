// window_ocr - Detect content layout in an image using Apple Vision framework
// Usage: window_ocr <image_path> <cursorNormX> <cursorNormY>
// Output: JSON crop bounds for the content column at the cursor position
//         e.g. {"x":0.18,"y":0.0,"width":0.60,"height":1.0}
//         Empty output on failure (no text detected, no column found)
//
// Uses fast text detection to find where text blocks are in the image,
// then merges overlapping bounding boxes on the x axis into "bands"
// (sidebar, editor, panel, etc.) and returns the band containing the cursor.
//
// Build: swiftc -O -o window_ocr src/window_ocr.swift -framework Vision -framework AppKit -framework Foundation

import Foundation
import Vision
import AppKit

let BAND_MERGE_PAD: CGFloat = 0.005  // 0.5% — merge only truly adjacent blocks
let CROP_PAD: CGFloat = 0.01         // 1% padding around the detected column

// --- Parse arguments ---

guard CommandLine.arguments.count >= 4,
      let cursorX = Double(CommandLine.arguments[2]).flatMap({ CGFloat($0) }),
      let cursorY = Double(CommandLine.arguments[3]).flatMap({ CGFloat($0) }),
      cursorX >= 0, cursorX <= 1, cursorY >= 0, cursorY <= 1 else {
    fputs("Usage: window_ocr <image_path> <cursorNormX> <cursorNormY>\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]

// --- Load image ---

guard let nsImage = NSImage(contentsOfFile: imagePath),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    exit(0)
}

// --- Detect text block positions (fast — we only need bounding boxes) ---

let request = VNRecognizeTextRequest()
request.recognitionLevel = .fast
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
} catch {
    exit(0)
}

guard let observations = request.results, !observations.isEmpty else {
    exit(0)
}

// --- Collect bounding boxes ---
// Vision coords: normalized [0,1], origin bottom-left.

struct TextRect {
    let minX: CGFloat
    let maxX: CGFloat
}

var rects: [TextRect] = []
for obs in observations {
    let bb = obs.boundingBox
    if bb.width > 0.001 {
        rects.append(TextRect(minX: bb.origin.x, maxX: bb.origin.x + bb.width))
    }
}

if rects.isEmpty { exit(0) }

// --- Band detection: merge overlapping x-intervals ---

let sorted = rects.sorted { $0.minX < $1.minX }

var bands: [(minX: CGFloat, maxX: CGFloat)] = []
for rect in sorted {
    if bands.isEmpty || rect.minX > bands[bands.count - 1].maxX + BAND_MERGE_PAD {
        bands.append((minX: rect.minX, maxX: rect.maxX))
    } else {
        bands[bands.count - 1].maxX = max(bands[bands.count - 1].maxX, rect.maxX)
    }
}

// If only one band detected, no cropping benefit — exit
if bands.count <= 1 { exit(0) }

// --- Find band containing cursor ---

var targetIdx = 0
var found = false
for i in 0..<bands.count {
    if cursorX >= bands[i].minX - BAND_MERGE_PAD && cursorX <= bands[i].maxX + BAND_MERGE_PAD {
        targetIdx = i
        found = true
        break
    }
}

if !found {
    var minDist: CGFloat = .greatestFiniteMagnitude
    for i in 0..<bands.count {
        let dist = min(abs(cursorX - bands[i].minX), abs(cursorX - bands[i].maxX))
        if dist < minDist {
            minDist = dist
            targetIdx = i
        }
    }
}

let target = bands[targetIdx]

// Add padding and clamp to [0, 1]
let cropX = max(0, target.minX - CROP_PAD)
let cropRight = min(1, target.maxX + CROP_PAD)
let cropWidth = cropRight - cropX

// Skip if the detected column covers nearly the full width (no benefit to cropping)
if cropWidth >= 0.85 { exit(0) }

// Output crop bounds as JSON (normalized coordinates)
let json = String(format: "{\"x\":%.4f,\"y\":0.0,\"width\":%.4f,\"height\":1.0}", cropX, cropWidth)
print(json, terminator: "")
