plugins {
    alias(libs.plugins.android.library)
}

/* The Rust core: UniFFI Kotlin bindings over libhushos_core.so, built by scripts/build-core.sh. */
android {
    namespace = "com.hushos.core"
    compileSdk = 37
    defaultConfig { minSdk = 29 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation("${libs.jna.get()}@aar")
}
