// swift-tools-version:6.0
import PackageDescription

/* What the app and both Files extensions share: the keychain, the Drive API, the vault that opens keys, and sign-in. */
let package = Package(
    name: "HushOSKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "HushOSKit", targets: ["HushOSKit"])],
    dependencies: [.package(path: "../HushOSCore")],
    targets: [
        // The BIP-39 English list, copied from crates/hushos-core/src/bip39-english.txt (a test keeps them equal), for fingerprint words.
        .target(name: "HushOSKit", dependencies: [.product(name: "HushOSCore", package: "HushOSCore")], resources: [.copy("Resources/bip39-english.txt")]),
        .testTarget(name: "HushOSKitTests", dependencies: ["HushOSKit"]),
    ]
)
