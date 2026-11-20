#!/usr/bin/env bash
# The Rust core for Android: a shared library per ABI and the UniFFI Kotlin
# bindings, placed in the :core Gradle module.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT="$ROOT/apps/android/core"
export CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_SSL_VERSION=tlsv1.2
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
# The NDK the app pins (ndkVersion), whatever else is installed or set: AGP strips these libraries and extracts their
# symbols with that one, so the core is built with it too. CI's android-toolchain action reads the same line.
NDK=$(sed -n 's/^[[:space:]]*ndkVersion = "\([0-9.]*\)".*/\1/p' "$ROOT/apps/android/app/build.gradle.kts")
[[ -n "$NDK" ]] || { echo "build-core: no ndkVersion in apps/android/app/build.gradle.kts" >&2; exit 1; }
revision() { sed -n 's/^Pkg.Revision *= *\([0-9.]*\).*/\1/p' "$1/source.properties" 2>/dev/null; }
# An ANDROID_NDK_HOME of that revision (a standalone copy, say) is kept; any other is replaced by the SDK's copy.
if [[ -z "${ANDROID_NDK_HOME:-}" || "$(revision "$ANDROID_NDK_HOME")" != "$NDK" ]]; then
    [[ "$(revision "$ANDROID_HOME/ndk/$NDK")" == "$NDK" ]] || {
        echo "build-core: NDK $NDK is not installed; run: sdkmanager --install \"ndk;$NDK\"" >&2
        exit 1
    }
    ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$NDK"
fi
export ANDROID_NDK_HOME ANDROID_NDK_ROOT="$ANDROID_NDK_HOME"
cd "$ROOT"
for target in aarch64-linux-android x86_64-linux-android; do
    rustup target list --installed | grep -q "^$target$" || rustup target add "$target"
done
rm -rf "$OUT/src/main/jniLibs" "$OUT/src/main/kotlin/com/hushos/core"
# A GNU build ID on each library: Play matches the native debug symbols a release bundle carries to a crash by it.
# The NDK's version as a cfg: Cargo does not see the NDK change, and would call a library linked by the old one fresh;
# flags it does see, so a new pin rebuilds the core and its C code.
# Cargo takes the first of CARGO_ENCODED_RUSTFLAGS, RUSTFLAGS and the target's flags that is set, so both go into
# that one, beside the caller's own, and only for this build (with --target, never into build scripts).
FLAGS=(-C "link-arg=-Wl,--build-id=sha1" "--cfg=hushos_android_ndk=\"$NDK\"")
if [[ -n "${CARGO_ENCODED_RUSTFLAGS+set}" ]]; then
    TARGET_FLAGS=("CARGO_ENCODED_RUSTFLAGS=${CARGO_ENCODED_RUSTFLAGS:+$CARGO_ENCODED_RUSTFLAGS$'\x1f'}$(IFS=$'\x1f'; echo "${FLAGS[*]}")")
elif [[ -n "${RUSTFLAGS+set}" ]]; then
    TARGET_FLAGS=("RUSTFLAGS=$RUSTFLAGS ${FLAGS[*]}")
else
    TARGET_FLAGS=("CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS=${FLAGS[*]}" "CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS=${FLAGS[*]}")
fi
env "${TARGET_FLAGS[@]}" cargo ndk -t arm64-v8a -t x86_64 -o "$OUT/src/main/jniLibs" build -p hushos-core --release
cargo run -q -p hushos-bindgen -- generate \
    --library target/aarch64-linux-android/release/libhushos_core.so \
    --language kotlin --out-dir "$OUT/src/main/kotlin"
echo "core: $(find "$OUT/src/main/jniLibs" -name '*.so' | wc -l | tr -d ' ') libraries, $(find "$OUT/src/main/kotlin" -name '*.kt' | wc -l | tr -d ' ') Kotlin files"
