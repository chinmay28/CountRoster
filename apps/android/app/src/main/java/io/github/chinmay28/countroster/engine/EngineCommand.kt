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
    /**
     * Scratch space (the app's cache dir). SQLite otherwise falls back to
     * /var/tmp, /tmp or the working directory, none writable by an app.
     */
    val tmpDir: String? = null,
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
    fun environment(secret: String): Map<String, String> = buildMap {
        put(SECRET_ENV, secret)
        tmpDir?.let {
            put("TMPDIR", it)
            put("SQLITE_TMPDIR", it)
        }
    }

    companion object {
        const val SECRET_ENV = "COUNTROSTER_ENGINE_SECRET"
        const val BINARY_NAME = "libcountroster_engine.so"
    }
}
