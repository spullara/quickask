plugins { id("com.android.application") }

android {
    namespace = "ai.quisk.app"
    compileSdk = 37
    defaultConfig {
        applicationId = "ai.quisk.app"
        minSdk = 29
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
        // Phones and Apple-silicon emulators; keeps the ONNX Runtime native libraries small.
        ndk { abiFilters += listOf("arm64-v8a") }
    }
    // The voice model is read from assets as-is.
    androidResources { noCompress += "onnx" }
    buildTypes { release { isMinifyEnabled = false } }
}

dependencies {
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.22.0")
}
