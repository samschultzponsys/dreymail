// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI passes the release version: -PversionName=1.8 (versionCode 108 = major * 100 + minor).
val appVersionName = (findProperty("versionName") as String?) ?: "0.0"
val appVersionCode = appVersionName.split(".").let { (it[0].toInt() * 100) + it.getOrElse(1) { "0" }.toInt() }.coerceAtLeast(1)

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
