#!/bin/bash
# Build script for native helpers (macOS)
set -e

cd "$(dirname "$0")"

echo "Building window_info (macOS)..."
swiftc -O -o window_info src/window_info.swift -framework CoreGraphics -framework AppKit
echo "Build successful: window_info"

echo "Building audio_ducking (macOS)..."
swiftc -O -o audio_ducking src/audio_ducking.swift
echo "Build successful: audio_ducking"
