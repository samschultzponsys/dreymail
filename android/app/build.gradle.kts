// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI passes the release version: -PversionName=26.11.2. Since 26.11 versions are YY.M.N (year,
// month, count from 0 each month): versionCode = YY * 100000 + M * 1000 + N (26.11.2 → 2611002).
// Before that, MAJOR.MINOR: major * 100 + minor (14.7 → 1407). Each scheme's codes are above the
// last one's, as Android requires.
val appVersionName = (findProperty("versionName") as String?) ?: "0.0"
val appVersionCode = appVersionName.split(".").map { it.toIntOrNull() ?: 0 }.let { p ->
    val (a, b, c) = Triple(p.getOrElse(0) { 0 }, p.getOrElse(1) { 0 }, p.getOrElse(2) { 0 })
    if (a >= 26) a * 100_000 + b * 1_000 + c else a * 100 + b
}.coerceAtLeast(1)

android {
    namespace = "io.github.samschultzponsys.dreymail"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.samschultzponsys.dreymail"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
    }

    // Release signing key from the environment (GitHub secrets in CI). Without it, release builds
    // stay unsigned and CI doesn't publish them.
    val keystore = System.getenv("DREYMAIL_KEYSTORE_FILE")
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("DREYMAIL_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DREYMAIL_KEY_ALIAS")
                keyPassword = System.getenv("DREYMAIL_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.core:core-ktx:1.15.0")
}
