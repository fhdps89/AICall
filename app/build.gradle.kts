plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.onecall.aivoice"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.onecall.aivoice"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.0.0-stage1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    // Fixed signing key for CI builds (so new APKs install over old ones).
    // Values come only from environment variables set by CI from GitHub Secrets;
    // without them, the default local debug keystore is used.
    val ciKeystoreFile = System.getenv("AICALL_KEYSTORE_FILE")
    val ciStorePassword = System.getenv("AICALL_STORE_PASSWORD")
    val ciKeyAlias = System.getenv("AICALL_KEY_ALIAS")
    val ciKeyPassword = System.getenv("AICALL_KEY_PASSWORD")
    val hasCiSigning = listOf(ciKeystoreFile, ciStorePassword, ciKeyAlias, ciKeyPassword)
        .all { !it.isNullOrBlank() } && file(ciKeystoreFile!!).exists()

    signingConfigs {
        if (hasCiSigning) {
            create("ci") {
                storeFile = file(ciKeystoreFile!!)
                storePassword = ciStorePassword
                keyAlias = ciKeyAlias
                keyPassword = ciKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            if (hasCiSigning) {
                signingConfig = signingConfigs.getByName("ci")
            }
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.3")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.7.7")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    testImplementation("junit:junit:4.13.2")
    // Real org.json for JVM unit tests (android.jar ships stubs only)
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
