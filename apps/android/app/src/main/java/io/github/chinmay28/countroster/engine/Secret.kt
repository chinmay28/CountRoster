package io.github.chinmay28.countroster.engine

import java.security.SecureRandom

/** The per-launch secret the engine's gate checks (≥32 chars, see Gate). */
object Secret {
    private val random = SecureRandom()

    fun generate(bytes: Int = 32): String {
        val buf = ByteArray(bytes)
        random.nextBytes(buf)
        return buf.joinToString("") { "%02x".format(it) }
    }
}
