# JNA and the UniFFI bindings are reached by name.
-keep class com.sun.jna.** { *; }
-keep class com.hushos.core.** { *; }
# Compile-time annotations Tink refers to, and JNA's desktop-only AWT hooks: neither exists on Android.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn java.awt.**

# ML Kit (Scan document) finds its parts by the class names in its manifest meta-data and builds each with its
# no-argument constructor. R8 doesn't read meta-data, so it dropped those constructors from the release build:
# ML Kit started half set up and Scan document crashed the app (debug builds aren't shrunk, so it only showed
# from Play).
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }

# Credential Manager (passkeys and security keys) finds its Play services provider by class name, on phones
# before Android 14.
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.** { *; }
