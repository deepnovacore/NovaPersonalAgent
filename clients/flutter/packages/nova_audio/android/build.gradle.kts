group = "com.nova.nova_audio"
version = "0.1.0"
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}
val aoqSdk = file("../Vendor/AoqClientSdk-release.aar")
android {
    namespace = "com.nova.nova_audio"
    compileSdk = 36
    defaultConfig { minSdk = 24; testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner" }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions { unitTests.isIncludeAndroidResources = true }
    sourceSets {
        getByName("main").java.srcDirs("src/main/kotlin", if (aoqSdk.exists()) "src/aoq/kotlin" else "src/noaoq/kotlin")
        getByName("test").java.srcDirs("src/test/kotlin")
    }
}
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 } }
dependencies {
    if (aoqSdk.exists()) implementation(mapOf("name" to "AoqClientSdk-release", "ext" to "aar"))
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("org.json:json:20250107")
}
tasks.withType<Test>().configureEach {
    // Robolectric downloads SDK jars and a lock file; keep both with isolated build outputs.
    val testHome = layout.buildDirectory.dir("test-home").get().asFile
    systemProperty("user.home", testHome.absolutePath)
    doFirst { testHome.mkdirs() }
    systemProperty("nova.manifest", project.file("src/main/AndroidManifest.xml").absolutePath)
    systemProperty("nova.fixtures", rootProject.file("../../../tests/fixtures/client-protocol/v1/vectors.json").absolutePath)
}
