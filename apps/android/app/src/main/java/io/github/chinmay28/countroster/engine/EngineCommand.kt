package io.github.chinmay28.countroster.engine

/**
 * How to launch the engine — the Kotlin half of the launcher contract in
 * server/cmd/engine/main.go. Keep the two in step.
 *
 * Pure data, so it's tested on the JVM.
 */
data class EngineCommand(
    /** The engine executable (libcountroster_engine.so in nativeLibraryDir). */
    val binary: String,
    /** Where the database, engine.json and safety bundles live. */
    val dataDir: String,
    /** IANA zone id. Go on Android can't read the system's, so it's passed. */
    val timezone: String,
    /** The active network's DNS servers, as IP literals. */
    val dnsServers: List<String> = emptyList(),
) {
    fun argv(): List<String> = buildList {
        add(binary)
        add("--data-dir"); add(dataDir)
        add("--host"); add("127.0.0.1")
        add("--port"); add("0")
        if (timezone.isNotBlank()) {
            add("--tz"); add(timezone)
        }
        if (dnsServers.isNotEmpty()) {
            add("--dns"); add(dnsServers.joinToString(","))
        }
    }

    /** The secret travels in the environment, never on the command line. */
    fun environment(secret: String): Map<String, String> = mapOf(SECRET_ENV to secret)

    companion object {
        const val SECRET_ENV = "COUNTROSTER_ENGINE_SECRET"
        const val BINARY_NAME = "libcountroster_engine.so"
    }
}
