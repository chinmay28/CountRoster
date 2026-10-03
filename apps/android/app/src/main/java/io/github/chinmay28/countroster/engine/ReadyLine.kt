package io.github.chinmay28.countroster.engine

/**
 * The engine announces it's listening with one stdout line:
 * `COUNTROSTER_ENGINE_READY {"port":41234,"version":"…","api_level":1}`.
 */
object ReadyLine {
    const val PREFIX = "COUNTROSTER_ENGINE_READY "
    private val portField = Regex("\"port\"\\s*:\\s*(\\d{1,5})")

    /** The port the line announces, or null if it isn't the ready line. */
    fun port(line: String): Int? {
        if (!line.startsWith(PREFIX)) return null
        val port = portField.find(line, PREFIX.length)?.groupValues?.get(1)?.toIntOrNull()
        return port?.takeIf { it in 1..65535 }
    }
}
