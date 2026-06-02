# Built as a subdirectory of parakeet.cpp: its top-level CMakeLists.txt
# `add_subdirectory()`s this folder at build time, so the `parakeet` target —
# and its transitive ggml + BLAS link graph — is already defined here. Linking
# against it produces a single self-contained static binary on every platform,
# with CMake (not hand-maintained archive lists) resolving the link order and
# per-generator output paths.
add_executable(parakeet_cpp_transcriber main.cpp)
target_link_libraries(parakeet_cpp_transcriber PRIVATE parakeet)

# Pin the output to one predictable directory across single-config (Makefiles,
# Ninja) and multi-config (MSVC, Xcode) generators so the build scripts can copy
# it without probing for a Release/ subfolder.
set_target_properties(parakeet_cpp_transcriber PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/stella-helper"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/stella-helper"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/stella-helper"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/stella-helper"
  RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}/stella-helper")
