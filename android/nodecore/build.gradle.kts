// Pure-Kotlin core of the phone node (no Android APIs), so it's unit-tested on a plain JVM:
// Freivalds checks byte-identical to delphi.site's web worker, Ethereum-style signing, and the message formats the
// attestor (delphi-genesis-node script/attestor.py) verifies.
plugins {
    id("org.jetbrains.kotlin.jvm")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin { jvmToolchain(17) }

dependencies {
    implementation("org.bouncycastle:bcprov-jdk18on:1.79")
    testImplementation(kotlin("test"))
    testImplementation("org.json:json:20240303")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test { useJUnitPlatform() }
