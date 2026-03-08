#!/bin/bash
# Build script for native helpers (macOS)
set -e

cd "$(dirname "$0")"

OUTPUT_DIR="out/darwin"
mkdir -p "$OUTPUT_DIR"

echo "Building window_info (macOS)..."
swiftc -O -o "$OUTPUT_DIR/window_info" src/window_info.swift -framework CoreGraphics -framework AppKit
echo "Build successful: $OUTPUT_DIR/window_info"

echo "Building audio_ducking (macOS)..."
swiftc -O -o "$OUTPUT_DIR/audio_ducking" src/audio_ducking.swift
echo "Build successful: $OUTPUT_DIR/audio_ducking"
