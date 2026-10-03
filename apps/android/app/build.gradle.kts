import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ABIs the Go engine is built for (scripts/build-android.sh). arm64-v8a is
// every current phone; x86_64 is the emulator.
val engineAbis = listOf("arm64-v8a", "x86_64")
val engineBinaries = engineAbis.map {
    layout.projectDirectory.file("src/main/jniLibs/$it/libcountroster_engine.so").asFile
}

// Release signing comes from the environment (CI secrets); without it a
// release build is simply unsigned.
val keystorePath: String? = System.getenv("COUNTROSTER_KEYSTORE")

android {
    namespace = "io.github.chinmay28.countroster"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.chinmay28.countroster"
        minSdk = 26
        targetSdk = 36
        // The calendar version and its commit count, passed in by
        // scripts/build-android.sh from scripts/version.mjs. The count is
        // monotonic, which is exactly what versionCode must be.
        versionCode = (findProperty("countroster.versionCode") as String?)?.toIntOrNull()?.coerceAtLeast(1) ?: 1
        versionName = (findProperty("countroster.versionName") as String?) ?: "dev"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += engineAbis }
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("COUNTROSTER_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("COUNTROSTER_KEY_ALIAS")
                keyPassword = System.getenv("COUNTROSTER_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { buildConfig = true }

    packaging {
        // The engine is an executable, not a library: Android only lets an app
        // exec files from its native library directory, and only extracts them
        // there when legacy packaging is on.
        jniLibs { useLegacyPackaging = true }
    }

    testOptions { unitTests.isReturnDefaultValues = true }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.work:work-runtime-ktx:2.10.2")

    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub under JVM unit tests; the real one stands in.
    testImplementation("org.json:json:20250517")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
}

val checkEngineBinaries by tasks.registering {
    description = "Fails early when the Go engine hasn't been built into jniLibs."
    doLast {
        val missing = engineBinaries.filterNot { it.exists() }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "Missing ${missing.joinToString()} — run scripts/build-android.sh, " +
                    "which builds the Go engine and the web bundle first.",
            )
        }
    }
}
tasks.named("preBuild") { dependsOn(checkEngineBinaries) }
