package io.github.chinmay28.countroster.engine

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The native shell's own calls to the engine, authenticated with the bearer
 * secret (the WebView uses the cookie instead).
 */
class EngineClient(private val endpoint: Endpoint) {

    /** Hand the engine the active network's DNS servers. */
    fun putDns(servers: List<String>) {
        val body = servers.joinToString(",", "{\"dns_servers\":[", "]}") { jsonString(it) }
        request("PUT", "/_engine/network", body).use { it.expect(204) }
    }

    /** Run one cloud-backup scheduler pass (the background job's hook). */
    fun cloudTick() {
        request("POST", "/_engine/cloud/tick", "").use { it.expect(204) }
    }

    /**
     * Download a same-origin [path] into [dest]; returns the filename the
     * engine suggested (Content-Disposition), if any.
     */
    fun download(path: String, dest: File): String? {
        require(path.startsWith("/") && !path.startsWith("//")) { "not a same-origin path: $path" }
        request("GET", path, null).use { res ->
            res.expect(200)
            dest.outputStream().use { out -> res.conn.inputStream.use { it.copyTo(out) } }
            return filenameFromDisposition(res.conn.getHeaderField("Content-Disposition"))
        }
    }

    private class Response(val conn: HttpURLConnection) : AutoCloseable {
        fun expect(status: Int) {
            val got = conn.responseCode
            if (got != status) {
                val detail = runCatching { conn.errorStream?.bufferedReader()?.readText() }.getOrNull()
                throw IOException("engine answered $got${detail?.let { ": $it" } ?: ""}")
            }
        }

        override fun close() = conn.disconnect()
    }

    private fun request(method: String, path: String, body: String?): Response {
        val conn = URL(endpoint.baseUrl + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 5_000
        conn.readTimeout = 5 * 60_000
        conn.setRequestProperty("Authorization", "Bearer ${endpoint.secret}")
        if (body != null && method != "GET") {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(body.toByteArray()) }
        }
        return Response(conn)
    }

    companion object {
        private val dispositionName = Regex("filename=\"?([^\";]+)\"?", RegexOption.IGNORE_CASE)

        fun filenameFromDisposition(header: String?): String? =
            header?.let { dispositionName.find(it)?.groupValues?.get(1)?.trim() }
                ?.substringAfterLast('/')
                ?.takeIf { it.isNotBlank() }

        internal fun jsonString(s: String): String = buildString {
            append('"')
            for (c in s) {
                when {
                    c == '"' -> append("\\\"")
                    c == '\\' -> append("\\\\")
                    c < ' ' -> append("\\u%04x".format(c.code))
                    else -> append(c)
                }
            }
            append('"')
        }
    }
}
