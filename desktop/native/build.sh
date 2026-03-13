#!/bin/bash
# Build script for native helpers (macOS)
set -e

cd "$(dirname "$0")"

OUTPUT_DIR="out/darwin"
mkdir -p "$OUTPUT_DIR"

echo "Building window_info (macOS)..."
swiftc -O -o "$OUTPUT_DIR/window_info" src/window_info.swift -framework CoreGraphics -framework AppKit
echo "Build successful: $OUTPUT_DIR/window_info"

echo "Building window_text (macOS)..."
swiftc -O -o "$OUTPUT_DIR/window_text" src/window_text.swift -framework ApplicationServices -framework Foundation
echo "Build successful: $OUTPUT_DIR/window_text"

echo "Building selected_text (macOS)..."
swiftc -O -o "$OUTPUT_DIR/selected_text" src/selected_text.swift -framework ApplicationServices -framework AppKit
echo "Build successful: $OUTPUT_DIR/selected_text"
