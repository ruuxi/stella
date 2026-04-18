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

echo "Building mouse_block (macOS)..."
swiftc -O -o "$OUTPUT_DIR/mouse_block" src/mouse_block.swift -framework CoreGraphics -framework AppKit -framework Foundation
echo "Build successful: $OUTPUT_DIR/mouse_block"

echo "Building desktop_automation (macOS)..."
swiftc -O -o "$OUTPUT_DIR/desktop_automation" src/desktop_automation.swift \
  -framework ApplicationServices \
  -framework AppKit \
  -framework Carbon \
  -framework CoreGraphics \
  -framework Foundation \
  -framework OSAKit \
  -framework ScreenCaptureKit
echo "Build successful: $OUTPUT_DIR/desktop_automation"

echo "Building desktop_overlay (macOS)..."
swiftc -O -o "$OUTPUT_DIR/desktop_overlay" src/desktop_overlay.swift \
  -framework AppKit \
  -framework CoreGraphics \
  -framework Foundation \
  -framework QuartzCore
echo "Build successful: $OUTPUT_DIR/desktop_overlay"

echo "Building home_apps (macOS)..."
swiftc -O -o "$OUTPUT_DIR/home_apps" src/home_apps.swift \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework Foundation
echo "Build successful: $OUTPUT_DIR/home_apps"

echo "Building home_capture (macOS)..."
swiftc -O -o "$OUTPUT_DIR/home_capture" src/home_capture.swift \
  -framework AppKit \
  -framework CoreGraphics \
  -framework Foundation \
  -framework ScreenCaptureKit
echo "Build successful: $OUTPUT_DIR/home_capture"
