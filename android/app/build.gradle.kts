plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI sets GITHUB_RUN_NUMBER, so every build installs as an update over the last one.
val build = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "site.delphi.nodes"
    compileSdk = 35

    defaultConfig {
        applicationId = "site.delphi.nodes"
        minSdk = 26
        targetSdk = 35
        versionCode = build
        versionName = "0.1.$build"
    }

    // Signing key comes from CI (generated once and kept in the repo's private Actions cache; never committed, since
    // this repo is public). Same key every build, so each new APK installs over the last one. Local builds without
    // the env vars fall back to the debug key.
    val ks = System.getenv("DELPHI_KEYSTORE")
    signingConfigs {
        if (ks != null) {
            create("shared") {
                storeFile = file(ks)
                storePassword = System.getenv("DELPHI_KEYSTORE_PASSWORD")
                keyAlias = "delphi-nodes"
                keyPassword = System.getenv("DELPHI_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("shared") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/BCKEY.DSA", "META-INF/BCKEY.SF")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation(project(":nodecore"))
}
