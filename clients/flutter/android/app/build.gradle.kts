plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

fun pushSetting(name: String): String = providers.gradleProperty(name).orNull ?: ""
fun quoted(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
val miPushSdk = providers.gradleProperty("novaMiPushSdk").orNull
val linuxRuntime = providers.environmentVariable("NOVA_ANDROID_LINUX_RUNTIME").orNull

android {
    namespace = "com.nova.nova_mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { buildConfig = true }
    // A missing vendor AAR is an explicit configuration failure for a selected MiPush build.
    if (pushSetting("novaPushProvider") == "mipush") require(miPushSdk != null && file(miPushSdk).isFile) { "novaMiPushSdk must point to the official vendor AAR" }
    defaultConfig {
        buildConfigField("String", "NOVA_PUSH_PROVIDER", quoted(pushSetting("novaPushProvider").ifEmpty { "fcm" }))
        buildConfigField("String", "NOVA_FCM_APPLICATION_ID", quoted(pushSetting("novaFcmApplicationId")))
        buildConfigField("String", "NOVA_FCM_API_KEY", quoted(pushSetting("novaFcmApiKey")))
        buildConfigField("String", "NOVA_FCM_PROJECT_ID", quoted(pushSetting("novaFcmProjectId")))
        buildConfigField("String", "NOVA_FCM_SENDER_ID", quoted(pushSetting("novaFcmSenderId")))
        buildConfigField("String", "NOVA_MIPUSH_APP_ID", quoted(pushSetting("novaMiPushAppId")))
        buildConfigField("String", "NOVA_MIPUSH_APP_KEY", quoted(pushSetting("novaMiPushAppKey")))
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.nova.nova_mobile"
        manifestPlaceholders["novaMiPushEnabled"] = (miPushSdk != null).toString()
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 24
        ndk { abiFilters += "arm64-v8a" }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    sourceSets.getByName("main") {
        if (miPushSdk != null) {
            java.srcDir("src/mipush/kotlin")
        }
        if (linuxRuntime != null) {
            jniLibs.srcDir("$linuxRuntime/jniLibs")
            assets.srcDir("$linuxRuntime/assets")
        }
    }
    packaging {
        jniLibs {
            // Executables must be installed to nativeLibraryDir for Android W^X.
            useLegacyPackaging = true
            keepDebugSymbols += setOf("**/libproot*.so", "**/libnova-exec.so")
        }
    }

    buildTypes {
        debug {
            if (providers.gradleProperty("novaAutonomyTest").orNull == "true") {
                applicationIdSuffix = ".autonomy"
            }
        }
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    implementation(platform("com.google.firebase:firebase-bom:34.4.0"))
    implementation("com.google.firebase:firebase-messaging")
    if (miPushSdk != null) implementation(files(miPushSdk))
    androidTestImplementation("androidx.test:runner:1.3.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250107")
}

val verifyLinuxRuntime by tasks.registering {
    doLast {
        require(linuxRuntime != null) { "Run tool/linux/android/build_runtime.py on the external build disk and set NOVA_ANDROID_LINUX_RUNTIME" }
        listOf("jniLibs/arm64-v8a/libproot.so", "jniLibs/arm64-v8a/libproot-loader.so", "jniLibs/arm64-v8a/libnova-exec.so", "assets/nova-linux/rootfs.tgz", "assets/nova-linux/rootfs.sha256").forEach {
            require(file("$linuxRuntime/$it").isFile) { "Missing Android Linux runtime artifact: $it" }
        }
    }
}
tasks.named("preBuild") { dependsOn(verifyLinuxRuntime) }
