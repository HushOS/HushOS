#!/usr/bin/env bash
# The Rust core for Android: a shared library per ABI and the UniFFI Kotlin
# bindings, placed in the :core Gradle module.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT="$ROOT/apps/android/core"
export CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_SSL_VERSION=tlsv1.2
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)}"
cd "$ROOT"
for target in aarch64-linux-android x86_64-linux-android; do
    rustup target list --installed | grep -q "^$target$" || rustup target add "$target"
done
rm -rf "$OUT/src/main/jniLibs" "$OUT/src/main/kotlin/com/hushos/core"
cargo ndk -t arm64-v8a -t x86_64 -o "$OUT/src/main/jniLibs" build -p hushos-core --release
cargo run -q -p hushos-bindgen -- generate \
    --library target/aarch64-linux-android/release/libhushos_core.so \
    --language kotlin --out-dir "$OUT/src/main/kotlin"
echo "core: $(find "$OUT/src/main/jniLibs" -name '*.so' | wc -l | tr -d ' ') libraries, $(find "$OUT/src/main/kotlin" -name '*.kt' | wc -l | tr -d ' ') Kotlin files"
