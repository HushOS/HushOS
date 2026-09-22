# JNA and the UniFFI bindings are reached by name.
-keep class com.sun.jna.** { *; }
-keep class com.hushos.core.** { *; }
# Compile-time annotations Tink refers to, and JNA's desktop-only AWT hooks: neither exists on Android.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn java.awt.**
