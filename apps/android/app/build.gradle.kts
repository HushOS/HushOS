plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.hushos.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.hushos.app"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        // The dev server on the host: `adb reverse tcp:5173 tcp:5173` makes localhost reach it.
        buildConfigField("String", "DEFAULT_ORIGIN", "\"http://localhost:5173\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signed with the debug key until a release key exists, so a shrunk build installs on a phone for testing.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    // JNA ships x86 and mips loaders too; phones and the emulator are arm64 and x86_64.
    packaging {
        jniLibs.excludes += listOf("**/x86/**", "**/mips/**", "**/mips64/**", "**/armeabi/**", "**/armeabi-v7a/**")
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

}

dependencies {
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.documentfile)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
}
