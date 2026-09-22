// swift-tools-version:6.0
import PackageDescription

/* What the app and both Files extensions share: the keychain, the Drive API, the vault that opens keys, and sign-in. */
let package = Package(
    name: "HushOSKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "HushOSKit", targets: ["HushOSKit"])],
    dependencies: [.package(path: "../HushOSCore")],
    targets: [
        .target(name: "HushOSKit", dependencies: [.product(name: "HushOSCore", package: "HushOSCore")]),
        .testTarget(name: "HushOSKitTests", dependencies: ["HushOSKit"]),
    ]
)
