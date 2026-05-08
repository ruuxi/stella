#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$script_dir/src/stella_computer_helper.cpp"
output_dir="$script_dir/out/win32"
obj="${TMPDIR:-/tmp}/stella_computer_helper.obj"
out="$output_dir/stella-computer-helper.exe"
xwin="${XWIN:-$HOME/Library/Caches/cargo-xwin/xwin}"
llvm="${LLVM:-/opt/homebrew/opt/llvm/bin}"
lld="${LLD:-$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/gcc-ld/lld-link}"

if [[ ! -d "$xwin" ]]; then
  echo "ERROR: xwin SDK cache not found at $xwin" >&2
  exit 1
fi
if [[ ! -x "$llvm/clang-cl" ]]; then
  echo "ERROR: clang-cl not found at $llvm/clang-cl" >&2
  exit 1
fi
if [[ ! -x "$lld" ]]; then
  echo "ERROR: lld-link not found at $lld" >&2
  exit 1
fi

mkdir -p "$output_dir"
rm -f "$obj" "$out" \
  "$output_dir"/stella-computer-helper.dll \
  "$output_dir"/stella-computer-helper.deps.json \
  "$output_dir"/stella-computer-helper.runtimeconfig.json \
  "$output_dir"/stella-computer-helper.pdb \
  "$output_dir"/Microsoft.Windows.SDK.NET.dll \
  "$output_dir"/WinRT.Runtime.dll

(
cd "$script_dir"
"$llvm/clang-cl" --target=x86_64-pc-windows-msvc /O2 /EHsc /std:c++17 /nologo /DUNICODE /D_UNICODE /c \
  /imsvc "$xwin/crt/include" \
  /imsvc "$xwin/sdk/include/ucrt" \
  /imsvc "$xwin/sdk/include/um" \
  /imsvc "$xwin/sdk/include/shared" \
  /imsvc "$xwin/sdk/include/winrt" \
  "src/stella_computer_helper.cpp" /Fo"$obj"
)

"$lld" /nologo /subsystem:console /machine:x64 \
  /libpath:"$xwin/crt/lib/x86_64" \
  /libpath:"$xwin/sdk/lib/um/x86_64" \
  /libpath:"$xwin/sdk/lib/ucrt/x86_64" \
  "$obj" ole32.lib oleaut32.lib uuid.lib user32.lib gdi32.lib gdiplus.lib shell32.lib \
  /out:"$out"

echo "Build successful: $out"
if command -v file >/dev/null 2>&1; then
  file "$out" || true
fi
