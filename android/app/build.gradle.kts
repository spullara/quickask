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
    }
    buildTypes { release { isMinifyEnabled = false } }
}
