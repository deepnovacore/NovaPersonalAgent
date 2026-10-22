// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription
import Foundation
// The vendor framework contains device code only; SwiftPM cannot filter a binary target by simulator.
let hasAOQ = ProcessInfo.processInfo.environment["NOVA_AOQ_SIMULATOR"] != "1" && FileManager.default.fileExists(atPath: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vendor/AoqClientSdk.xcframework").path)

let package = Package(
    name: "nova_audio",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .library(name: "nova-audio", targets: ["nova_audio"])
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework")
    ],
    targets: [
        .target(
            name: "nova_audio",
            dependencies: [
                .product(name: "FlutterFramework", package: "FlutterFramework")
            ] + (hasAOQ ? [.target(name: "AoqClientSdk")] : []),
            resources: [.process("Resources")
            ]
        )
    ] + (hasAOQ ? [.binaryTarget(name: "AoqClientSdk", path: "Vendor/AoqClientSdk.xcframework")] : [])
)
