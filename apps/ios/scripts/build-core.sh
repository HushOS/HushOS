#!/usr/bin/env bash
# The Rust core for Apple platforms: a static library per slice, the UniFFI
# Swift bindings, and an xcframework, assembled into the HushOSCore package.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT="$ROOT/apps/ios/Packages/HushOSCore"
export CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_SSL_VERSION=tlsv1.2
cd "$ROOT"
TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim)
for target in "${TARGETS[@]}"; do
    rustup target list --installed | grep -q "^$target$" || rustup target add "$target"
    cargo build -p hushos-core --release --target "$target"
done
GENERATED=$(mktemp -d)
cargo run -q -p hushos-bindgen -- generate \
    --library "target/${TARGETS[1]}/release/libhushos_core.a" \
    --language swift --out-dir "$GENERATED"
rm -rf "$OUT/Sources/HushOSCore" "$OUT/HushOSCoreFFI.xcframework"
mkdir -p "$OUT/Sources/HushOSCore" "$GENERATED/include"
mv "$GENERATED"/*.swift "$OUT/Sources/HushOSCore/"
mv "$GENERATED"/*.h "$GENERATED/include/"
mv "$GENERATED"/*.modulemap "$GENERATED/include/module.modulemap"
xcodebuild -quiet -create-xcframework \
    -library "target/${TARGETS[0]}/release/libhushos_core.a" -headers "$GENERATED/include" \
    -library "target/${TARGETS[1]}/release/libhushos_core.a" -headers "$GENERATED/include" \
    -output "$OUT/HushOSCoreFFI.xcframework"
rm -rf "$GENERATED"
echo "HushOSCore: $(ls "$OUT/Sources/HushOSCore") + HushOSCoreFFI.xcframework"
