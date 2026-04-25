// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ParakeetTranscriber",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "parakeet_transcriber", targets: ["ParakeetTranscriber"])
  ],
  dependencies: [
    .package(url: "https://github.com/FluidInference/FluidAudio", branch: "main")
  ],
  targets: [
    .executableTarget(
      name: "ParakeetTranscriber",
      dependencies: [
        .product(name: "FluidAudio", package: "FluidAudio")
      ]
    )
  ]
)
