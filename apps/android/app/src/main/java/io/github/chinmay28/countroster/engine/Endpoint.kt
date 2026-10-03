package io.github.chinmay28.countroster.engine

/** A running engine: where it listens and the secret it admits. */
data class Endpoint(val port: Int, val secret: String) {
    val baseUrl: String get() = "http://127.0.0.1:$port"

    /** The cookie the WebView carries (see the engine's Gate). */
    val cookie: String get() = "$SESSION_COOKIE=$secret; Path=/; HttpOnly; SameSite=Strict"

    override fun toString() = "Endpoint($baseUrl)" // never log the secret

    companion object {
        const val SESSION_COOKIE = "cr_session"
    }
}
