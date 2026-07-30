#!/bin/bash
# Build script for native helpers (macOS)
set -e

cd "$(dirname "$0")"

OUTPUT_DIR="out/darwin"
mkdir -p "$OUTPUT_DIR"

MACOS_MIN_VERSION="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Pinned parakeet.cpp (C++/ggml ASR) revision used for the Intel-macOS local
# dictation helper. Bump deliberately and re-verify a transcription.
PARAKEET_CPP_REPO="https://github.com/mudler/parakeet.cpp"
PARAKEET_CPP_COMMIT="9edf17c3ada66e0f881dcff155492867db7ac4cf"

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

build_c_bundle_universal() {
  local bundle_name="$1"
  local executable_name="$2"
  local source="$3"
  local info_plist="$4"
  shift 4

  clang -O2 -target "arm64-apple-macosx$MACOS_MIN_VERSION" -bundle -o "$TMP_DIR/$executable_name-arm64" "$source" "$@"
  clang -O2 -target "x86_64-apple-macosx$MACOS_MIN_VERSION" -bundle -o "$TMP_DIR/$executable_name-x64" "$source" "$@"

  local bundle_dir="$OUTPUT_DIR/$bundle_name"
  rm -rf "$bundle_dir"
  mkdir -p "$bundle_dir/Contents/MacOS"
  cp "$info_plist" "$bundle_dir/Contents/Info.plist"
  lipo -create -output "$bundle_dir/Contents/MacOS/$executable_name" \
    "$TMP_DIR/$executable_name-arm64" \
    "$TMP_DIR/$executable_name-x64"
  chmod +x "$bundle_dir/Contents/MacOS/$executable_name"
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$bundle_dir" >/dev/null 2>&1 || true
  fi
}

build_c_app_universal() {
  local app_name="$1"
  local executable_name="$2"
  local source="$3"
  local info_plist="$4"
  shift 4

  clang -O2 -target "arm64-apple-macosx$MACOS_MIN_VERSION" -o "$TMP_DIR/$executable_name-arm64" "$source" "$@"
  clang -O2 -target "x86_64-apple-macosx$MACOS_MIN_VERSION" -o "$TMP_DIR/$executable_name-x64" "$source" "$@"

  local app_dir="$OUTPUT_DIR/$app_name"
  rm -rf "$app_dir"
  mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"
  cp "$info_plist" "$app_dir/Contents/Info.plist"
  if [ -f "../build/icon.icns" ]; then
    cp "../build/icon.icns" "$app_dir/Contents/Resources/icon.icns"
  fi
  lipo -create -output "$app_dir/Contents/MacOS/$executable_name" \
    "$TMP_DIR/$executable_name-arm64" \
    "$TMP_DIR/$executable_name-x64"
  chmod +x "$app_dir/Contents/MacOS/$executable_name"
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$app_dir" >/dev/null 2>&1 || true
  fi
}

# parakeet_cpp_transcriber — local dictation for Intel macOS (arm64 uses the
# CoreML helper below). Builds parakeet.cpp + ggml statically and links our
# wrapper into one self-contained x86_64 binary. Every step is non-fatal: a
# failure here just leaves Intel Macs on cloud dictation instead of blocking the
# whole native build.
build_parakeet_cpp_x64() {
  if ! command -v cmake >/dev/null 2>&1; then
    echo "Skipping parakeet_cpp_transcriber: cmake not on PATH."
    return 0
  fi
  local src="$TMP_DIR/parakeet.cpp"
  local log="$TMP_DIR/parakeet-cpp-build.log"
  echo "Cloning parakeet.cpp ($PARAKEET_CPP_COMMIT)..."
  if ! git clone --quiet "$PARAKEET_CPP_REPO" "$src" 2>"$log" \
    || ! git -C "$src" checkout --quiet "$PARAKEET_CPP_COMMIT" 2>>"$log" \
    || ! git -C "$src" submodule update --init --recursive --quiet 2>>"$log"; then
    echo "WARNING: parakeet.cpp checkout failed; skipping parakeet_cpp_transcriber."
    tail -5 "$log" 2>/dev/null || true
    return 0
  fi

  # Register our wrapper inside the parakeet.cpp tree so CMake links it against
  # the in-tree `parakeet` target (and its transitive ggml + BLAS graph).
  mkdir -p "$src/examples/stella"
  cp "src/parakeet-cpp/main.cpp" "$src/examples/stella/main.cpp"
  cp "src/parakeet-cpp/CMakeLists.txt" "$src/examples/stella/CMakeLists.txt"
  echo "add_subdirectory(examples/stella)" >> "$src/CMakeLists.txt"

  echo "Building parakeet_cpp_transcriber (static, x86_64)..."
  # -include cstdint: parakeet.cpp's backend.hpp uses int64_t without including
  # <cstdint>; Apple clang pulls it in transitively but stricter toolchains do
  # not. Force-include keeps the build compiler-portable without patching source.
  if ! cmake -S "$src" -B "$src/build" \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_OSX_ARCHITECTURES=x86_64 \
      -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_MIN_VERSION" \
      -DCMAKE_CXX_FLAGS="-include cstdint" \
      -DPARAKEET_SHARED=OFF \
      -DBUILD_SHARED_LIBS=OFF \
      -DPARAKEET_BUILD_CLI=OFF \
      -DPARAKEET_BUILD_TESTS=OFF \
      -DGGML_NATIVE=OFF \
      -DGGML_METAL=OFF >>"$log" 2>&1 \
    || ! cmake --build "$src/build" --target parakeet_cpp_transcriber \
         -j"$(sysctl -n hw.ncpu)" >>"$log" 2>&1; then
    echo "WARNING: parakeet.cpp build failed; skipping parakeet_cpp_transcriber."
    tail -15 "$log" 2>/dev/null || true
    return 0
  fi

  local built="$src/build/stella-helper/parakeet_cpp_transcriber"
  if [ ! -f "$built" ]; then
    echo "WARNING: parakeet_cpp_transcriber binary not found after build."
    return 0
  fi
  cp "$built" "$OUTPUT_DIR/parakeet_cpp_transcriber"
  chmod +x "$OUTPUT_DIR/parakeet_cpp_transcriber"
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$OUTPUT_DIR/parakeet_cpp_transcriber" >/dev/null 2>&1 || true
  fi
  echo "Build successful: $OUTPUT_DIR/parakeet_cpp_transcriber (x86_64)"
}

echo "Building disclaim-spawn (macOS)..."
build_c_universal "disclaim-spawn" "../scripts/disclaim-spawn.c"
echo "Build successful: $OUTPUT_DIR/disclaim-spawn"

echo "Building window_info (macOS)..."
build_swift_universal "window_info" "src/window_info.swift" -framework CoreGraphics -framework AppKit -framework ScreenCaptureKit
echo "Build successful: $OUTPUT_DIR/window_info"

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

echo "Building locked_use_installer (macOS)..."
build_swift_universal "locked_use_installer" "src/locked_use_installer.swift" \
  -framework Foundation
echo "Build successful: $OUTPUT_DIR/locked_use_installer"

echo "Building Stella.app authorization helper (macOS)..."
build_c_app_universal \
  "Stella.app" \
  "Stella" \
  "src/locked_use_authorizer.c" \
  "src/locked_use_authorizer.Info.plist" \
  -framework CoreFoundation \
  -framework Security
echo "Build successful: $OUTPUT_DIR/Stella.app"

echo "Building StellaLockedComputerUseAuthorizationPlugin.bundle (macOS)..."
build_c_bundle_universal \
  "StellaLockedComputerUseAuthorizationPlugin.bundle" \
  "StellaLockedComputerUseAuthorizationPlugin" \
  "src/locked_use_auth_plugin.c" \
  "src/locked_use_auth_plugin.Info.plist" \
  -framework CoreFoundation \
  -framework Security
echo "Build successful: $OUTPUT_DIR/StellaLockedComputerUseAuthorizationPlugin.bundle"

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
  -framework ApplicationServices \
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

echo "Building meeting_capture (macOS)..."
build_swift_universal "meeting_capture" "src/meeting_capture.swift" \
  -framework AVFoundation \
  -framework AppKit \
  -framework CoreAudio \
  -framework CoreMedia \
  -framework Foundation \
  -framework ScreenCaptureKit
echo "Build successful: $OUTPUT_DIR/meeting_capture"

if [ "$(uname -m)" = "arm64" ]; then
  echo "Building parakeet_transcriber (macOS arm64)..."
  swift build -c release --package-path src/parakeet-helper
  cp src/parakeet-helper/.build/release/parakeet_transcriber "$OUTPUT_DIR/parakeet_transcriber"
  echo "Build successful: $OUTPUT_DIR/parakeet_transcriber"
else
  echo "Skipping parakeet_transcriber: Parakeet Core ML is only enabled for macOS arm64."
fi

build_parakeet_cpp_x64

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
