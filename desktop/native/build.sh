#!/bin/bash
# Build script for native helpers (macOS)
set -e

cd "$(dirname "$0")"

OUTPUT_DIR="out/darwin"
mkdir -p "$OUTPUT_DIR"

echo "Building window_info (macOS)..."
swiftc -O -o "$OUTPUT_DIR/window_info" src/window_info.swift -framework CoreGraphics -framework AppKit -framework ScreenCaptureKit
echo "Build successful: $OUTPUT_DIR/window_info"

echo "Building selected_text (macOS)..."
swiftc -O -o "$OUTPUT_DIR/selected_text" src/selected_text.swift -framework ApplicationServices -framework AppKit
echo "Build successful: $OUTPUT_DIR/selected_text"

echo "Building screen_permission (macOS)..."
swiftc -O -o "$OUTPUT_DIR/screen_permission" src/screen_permission.swift -framework CoreGraphics -framework Foundation
echo "Build successful: $OUTPUT_DIR/screen_permission"

echo "Building window_ocr (macOS)..."
swiftc -O -o "$OUTPUT_DIR/window_ocr" src/window_ocr.swift -framework Vision -framework AppKit -framework Foundation
echo "Build successful: $OUTPUT_DIR/window_ocr"
