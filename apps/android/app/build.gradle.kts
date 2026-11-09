import java.net.URI
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

/*
 * The server a build type talks to, and the links it answers: one origin, so the app never
 * calls its own server's links "another server". -PdefaultOrigin=https://drive.example.org
 * points a self-hosted build at its own server; only https links are verified, through
 * that server's /.well-known/assetlinks.json.
 */
fun serves(type: com.android.build.api.dsl.ApplicationBuildType, fallback: String) {
    val origin = ((project.findProperty("defaultOrigin") as String?) ?: fallback).trimEnd('/')
    val uri = URI(origin)
    type.buildConfigField("String", "DEFAULT_ORIGIN", "\"$origin\"")
    type.manifestPlaceholders["appLinkScheme"] = uri.scheme
    type.manifestPlaceholders["appLinkHost"] = uri.host
    type.manifestPlaceholders["appLinkVerify"] = (uri.scheme == "https").toString()
}

/*
 * The upload key that signs what goes to Google Play, from apps/android/keystore.properties
 * (never committed) or the HUSHOS_UPLOAD_* environment variables; docs/release/signing.md has
 * the steps. Without a keystore and its password, release builds stay signed with the debug key
 * so a shrunk build still installs on a phone for testing; Play refuses a debug-signed bundle,
 * and scripts/bundle-release.sh refuses to produce one.
 */
val uploadKey: Map<String, String>? = run {
    val file = rootProject.file("keystore.properties")
    val properties = Properties()
    if (file.isFile) file.inputStream().use { properties.load(it) }
    fun value(key: String, variable: String): String? =
        properties.getProperty(key) ?: providers.environmentVariable(variable).orNull
    val storeFile = value("storeFile", "HUSHOS_UPLOAD_STORE_FILE") ?: return@run null
    // No password (a debug build, say): stay on the debug key rather than fail every task.
    val storePassword = value("storePassword", "HUSHOS_UPLOAD_STORE_PASSWORD") ?: return@run null
    mapOf(
        "storeFile" to storeFile,
        "storePassword" to storePassword,
        "keyAlias" to (value("keyAlias", "HUSHOS_UPLOAD_KEY_ALIAS") ?: "upload"),
        "keyPassword" to (value("keyPassword", "HUSHOS_UPLOAD_KEY_PASSWORD") ?: storePassword),
    )
}

/*
 * Firebase Cloud Messaging, for phone notifications (docs/push-relay-plan.md, PR 4). The Firebase app's project id,
 * app id, API key and sender id are configuration, not secrets (Google's own google-services.json carries them in the
 * clear), but they name HushOS's Firebase project, so they come from Gradle properties rather than the repository:
 * -Phushos.firebase.projectId=… (or ~/.gradle/gradle.properties, or HUSHOS_FIREBASE_PROJECT_ID and so on). A build
 * without all four has no phone notifications, and nothing of Firebase runs.
 */
fun firebase(name: String, variable: String): String =
    ((project.findProperty("hushos.firebase.$name") as String?) ?: providers.environmentVariable(variable).orNull ?: "").trim()

val firebaseOptions = mapOf(
    "FIREBASE_PROJECT_ID" to firebase("projectId", "HUSHOS_FIREBASE_PROJECT_ID"),
    "FIREBASE_APP_ID" to firebase("appId", "HUSHOS_FIREBASE_APP_ID"),
    "FIREBASE_API_KEY" to firebase("apiKey", "HUSHOS_FIREBASE_API_KEY"),
    "FIREBASE_SENDER_ID" to firebase("senderId", "HUSHOS_FIREBASE_SENDER_ID"),
)
val firebaseMissing: List<String> = firebaseOptions.filterValues { it.isEmpty() }.keys.map {
    "hushos.firebase." + it.removePrefix("FIREBASE_").lowercase().split('_')
        .mapIndexed { i, part -> if (i == 0) part else part.replaceFirstChar(Char::uppercase) }.joinToString("")
}
val firebaseRefusal = "A release build needs phone notifications: set ${firebaseMissing.joinToString(", ")} " +
    "(Gradle properties, or the HUSHOS_FIREBASE_* variables; docs/push-relay-plan.md, owner checklist)."

/*
 * Release builds go to people, so one without Firebase fails: at configuration when a release task is asked for by name
 * (before anything compiles), and by `requireFirebase` ahead of the release tasks for any other way in. Debug builds stay
 * push-less without it.
 */
val askedForRelease = gradle.startParameter.taskNames.any { it.substringAfterLast(':') in setOf("assembleRelease", "bundleRelease") }
if (askedForRelease && firebaseMissing.isNotEmpty()) throw GradleException(firebaseRefusal)
val requireFirebase = tasks.register("requireFirebase") {
    val missing = firebaseMissing
    val refusal = firebaseRefusal
    doLast { if (missing.isNotEmpty()) throw GradleException(refusal) }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(requireFirebase) }

/*
 * The build number (versionCode): -PbuildNumber, which scripts/bundle-release.sh takes from
 * scripts/build-number.sh (the commit count on main, which only grows), or the same count here
 * for builds that pass nothing, such as Android Studio's. A checkout without git history says 1.
 */
val buildNumber: Int = (project.findProperty("buildNumber") as String?)?.toInt()
    ?: runCatching {
        providers.exec { commandLine("git", "rev-list", "--count", "HEAD") }
            .standardOutput.asText.get().trim().toInt()
    }.getOrDefault(1)

android {
    namespace = "com.hushos.app"
    compileSdk = 37
    // The NDK the Rust core is built with (scripts/build-core.sh takes the newest installed): AGP strips the packaged native
    // libraries and extracts their symbols with it. Without one it packages them unstripped and extracts nothing.
    ndkVersion = "27.1.12297006"

    defaultConfig {
        applicationId = "com.hushos.app"
        minSdk = 29
        targetSdk = 36
        versionCode = buildNumber
        // The product version (the root package.json): the release pull request sets it.
        versionName = "1.3.0" // x-release-please-version
        for ((field, value) in firebaseOptions) buildConfigField("String", field, "\"${value.replace("\"", "")}\"")
        // Read by check-bundle.sh: a bundle for Play must carry notifications.
        manifestPlaceholders["pushConfigured"] = (firebaseMissing.isEmpty()).toString()
    }

    signingConfigs {
        if (uploadKey != null) {
            create("upload") {
                storeFile = rootProject.file(uploadKey.getValue("storeFile"))
                storePassword = uploadKey.getValue("storePassword")
                keyAlias = uploadKey.getValue("keyAlias")
                keyPassword = uploadKey.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        // Debug talks to the dev server (`adb reverse tcp:5173 tcp:5173` makes localhost reach it,
        // on the emulator and on a phone over USB); release talks to production.
        debug { serves(this, "http://localhost:5173") }
        release {
            serves(this, "https://hushos.com")
            // The Rust core's symbol table goes into the bundle's BUNDLE-METADATA, for Play to symbolicate native crashes;
            // the libraries the app ships are stripped of it (they don't grow). FULL would need DWARF the core isn't built with.
            ndk { debugSymbolLevel = "SYMBOL_TABLE" }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName(if (uploadKey != null) "upload" else "debug")
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

    // The Alpine tokens (com.hushos.tokens), generated by `bun run tokens` from packages/tokens.
    // Read in place, not copied, so regenerating them updates the app.
    sourceSets.getByName("main").kotlin.srcDir("../../../packages/tokens/generated")
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
    // Foldables and large screens: the bar, rail or wide rail by window size, Info beside the list, and the fold's posture.
    implementation(libs.androidx.compose.material3.navigation.suite)
    implementation(libs.androidx.compose.material3.adaptive)
    implementation(libs.androidx.compose.material3.adaptive.layout)
    implementation(libs.androidx.compose.material3.adaptive.navigation)
    implementation(libs.androidx.window)
    // Dialog and sheet state kept in memory across a fold or a resize, never written to the saved-state bundle.
    implementation(libs.androidx.compose.runtime.retain)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.documentfile)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
    implementation(libs.androidx.work.runtime)
    // QR codes for links (encoding only): the same address as Copy link, drawn for a camera.
    implementation(libs.zxing.core)
    // Scanning a recovery kit's code: CameraX frames, decoded by ZXing on the phone.
    // Privacy policy and terms open in a Custom Tab.
    implementation(libs.androidx.browser)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    // Scan document: Google's scanner, run by Play services on the phone (edges, cleanup, pages), handing back a PDF.
    implementation(libs.mlkit.document.scanner)
    // Phone notifications: FCM data messages only, set up from BuildConfig (PushTokens), no Google Services plugin.
    implementation(libs.firebase.messaging)
    // getToken's Task, which firebase-messaging needs at run time only.
    implementation(libs.play.services.tasks)
    // The Markdown viewer: CommonMark and GitHub's tables, task lists, strikethrough and autolinks, as the web parses them.
    implementation(libs.commonmark)
    implementation(libs.commonmark.tables)
    implementation(libs.commonmark.tasks)
    implementation(libs.commonmark.strikethrough)
    implementation(libs.commonmark.autolink)
    testImplementation(libs.junit)
    // JVM tests open real envelopes: JNA's desktop jar loads the core built for this machine.
    testImplementation(libs.jna)
    // android.jar's org.json is stubs that throw on the JVM; settings tests edit real JSON.
    testImplementation(libs.org.json)
    // Vault against a fake server on loopback (VaultAttributesTest): a real Context for its files, SQLite mirror and preferences.
    testImplementation(libs.robolectric)
    // The transfer workers run whole in JVM tests (UploadWorkerTest): WorkManager's test executor and drivers.
    testImplementation(libs.androidx.work.testing)
}

/*
 * The Rust core for this machine, for JVM unit tests that seal and open real envelopes
 * (restored-version sizes, for one). Built by cargo next to the phone libraries.
 */
val repoRoot: File = rootProject.projectDir.parentFile.parentFile
val hostCore = tasks.register<Exec>("hostCore") {
    workingDir = repoRoot
    commandLine("cargo", "build", "-q", "-p", "hushos-core", "--release")
}
tasks.withType<Test>().configureEach {
    dependsOn(hostCore)
    systemProperty("jna.library.path", File(repoRoot, "target/release").path)
    // The JVM's HttpURLConnection has no PATCH (Android's has): FamilyFixture.allowPatch adds it to the test JVM only,
    // so route 18's role changes run in unit tests as on a phone.
    jvmArgs("--add-opens=java.base/java.net=ALL-UNNAMED")
}
