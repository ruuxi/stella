#!/bin/bash
# Build script for native helpers (macOS)
set -e

cd "$(dirname "$0")"

OUTPUT_DIR="out/darwin"
mkdir -p "$OUTPUT_DIR"

MACOS_MIN_VERSION="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

build_c_universal() {
  local output="$1"
  local source="$2"
  shift 2

  clang -O2 -target "arm64-apple-macosx$MACOS_MIN_VERSION" -o "$TMP_DIR/$output-arm64" "$source" "$@"
  clang -O2 -target "x86_64-apple-macosx$MACOS_MIN_VERSION" -o "$TMP_DIR/$output-x64" "$source" "$@"
  lipo -create -output "$OUTPUT_DIR/$output" "$TMP_DIR/$output-arm64" "$TMP_DIR/$output-x64"
}

build_swift_universal() {
  local output="$1"
  local source="$2"
  shift 2

  swiftc -O -target "arm64-apple-macosx$MACOS_MIN_VERSION" -o "$TMP_DIR/$output-arm64" "$source" "$@"
  swiftc -O -target "x86_64-apple-macosx$MACOS_MIN_VERSION" -o "$TMP_DIR/$output-x64" "$source" "$@"
  lipo -create -output "$OUTPUT_DIR/$output" "$TMP_DIR/$output-arm64" "$TMP_DIR/$output-x64"
}

echo "Building disclaim-spawn (macOS)..."
build_c_universal "disclaim-spawn" "../scripts/disclaim-spawn.c"
echo "Build successful: $OUTPUT_DIR/disclaim-spawn"

echo "Building window_info (macOS)..."
build_swift_universal "window_info" "src/window_info.swift" -framework CoreGraphics -framework AppKit -framework ScreenCaptureKit
echo "Build successful: $OUTPUT_DIR/window_info"

echo "Building selected_text (macOS)..."
build_swift_universal "selected_text" "src/selected_text.swift" -framework ApplicationServices -framework AppKit -framework Carbon
echo "Build successful: $OUTPUT_DIR/selected_text"

echo "Building dictation_bridge (macOS)..."
build_swift_universal "dictation_bridge" "src/dictation_bridge.swift" -framework ApplicationServices -framework AppKit -framework AudioToolbox -framework Carbon -framework CoreAudio
echo "Build successful: $OUTPUT_DIR/dictation_bridge"

echo "Building screen_permission (macOS)..."
build_swift_universal "screen_permission" "src/screen_permission.swift" -framework CoreGraphics -framework Foundation
echo "Build successful: $OUTPUT_DIR/screen_permission"

echo "Building window_ocr (macOS)..."
build_swift_universal "window_ocr" "src/window_ocr.swift" -framework Vision -framework AppKit -framework Foundation
echo "Build successful: $OUTPUT_DIR/window_ocr"

echo "Building desktop_automation (macOS)..."
build_swift_universal "desktop_automation" "src/desktop_automation.swift" \
  -framework ApplicationServices \
  -framework AppKit \
  -framework Carbon \
  -framework CoreGraphics \
  -framework Foundation \
  -framework OSAKit \
  -framework ScreenCaptureKit
echo "Build successful: $OUTPUT_DIR/desktop_automation"

echo "Building home_apps (macOS)..."
build_swift_universal "home_apps" "src/home_apps.swift" \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework Foundation
echo "Build successful: $OUTPUT_DIR/home_apps"

echo "Building home_capture (macOS)..."
build_swift_universal "home_capture" "src/home_capture.swift" \
  -framework AppKit \
  -framework CoreGraphics \
  -framework Foundation \
  -framework ScreenCaptureKit
echo "Build successful: $OUTPUT_DIR/home_capture"

echo "Building chronicle (macOS)..."
build_swift_universal "chronicle" "src/chronicle.swift" \
  -framework AppKit \
  -framework CoreGraphics \
  -framework Foundation \
  -framework ScreenCaptureKit \
  -framework Vision
echo "Build successful: $OUTPUT_DIR/chronicle"

if [ "$(uname -m)" = "arm64" ]; then
  echo "Building parakeet_transcriber (macOS arm64)..."
  swift build -c release --package-path src/parakeet-helper
  cp src/parakeet-helper/.build/release/parakeet_transcriber "$OUTPUT_DIR/parakeet_transcriber"
  echo "Build successful: $OUTPUT_DIR/parakeet_transcriber"
else
  echo "Skipping parakeet_transcriber: Parakeet Core ML is only enabled for macOS arm64."
fi

# wakeword_listener — Rust binary, universal macOS via cargo + lipo. Skipped
# silently if cargo is unavailable so this file is not a hard-dependency on
# rustup for contributors who only touch the C++/Swift helpers.
if command -v cargo >/dev/null 2>&1; then
  echo "Building wakeword_listener (macOS universal)..."
  pushd wakeword >/dev/null
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1 || true
  MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN_VERSION" cargo build --release --quiet --target aarch64-apple-darwin
  MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN_VERSION" cargo build --release --quiet --target x86_64-apple-darwin
  popd >/dev/null
  lipo -create \
    -output "$OUTPUT_DIR/wakeword_listener" \
    "wakeword/target/aarch64-apple-darwin/release/wakeword_listener" \
    "wakeword/target/x86_64-apple-darwin/release/wakeword_listener"
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$OUTPUT_DIR/wakeword_listener" >/dev/null 2>&1 || true
  fi
  mkdir -p "$OUTPUT_DIR/wakeword_models"
  cp wakeword/models/hey_stella.onnx "$OUTPUT_DIR/wakeword_models/hey_stella.onnx"
  echo "Build successful: $OUTPUT_DIR/wakeword_listener"
else
  echo "Skipping wakeword_listener: cargo not on PATH (install rustup to enable)."
fi
