package io.github.chinmay28.countroster.bridge

import org.json.JSONException
import org.json.JSONObject

/**
 * A request from the web client over `window.CountRosterNative.postMessage`
 * (apps/web/src/lib/platform.ts): `{"id": n, "method": "...", "args": {...}}`.
 */
data class BridgeRequest(val id: Int, val method: String, val args: JSONObject) {
    fun string(name: String): String? = args.optString(name, "").takeIf { it.isNotEmpty() }

    companion object {
        /** Null for anything that isn't a well-formed request. */
        fun parse(json: String): BridgeRequest? = try {
            val o = JSONObject(json)
            BridgeRequest(o.getInt("id"), o.getString("method"), o.optJSONObject("args") ?: JSONObject())
        } catch (_: JSONException) {
            null
        }
    }
}

/** The script that answers request [id] — the client's reply hook. */
object BridgeReply {
    fun script(id: Int, ok: Boolean, value: Any?): String {
        val json = when (value) {
            null -> "null"
            is Boolean -> value.toString()
            is Number -> value.toString()
            else -> JSONObject.quote(value.toString())
        }
        return "window.__countrosterNativeReply && window.__countrosterNativeReply($id, $ok, $json);"
    }
}

/** What this host offers — keep in step with NativeCapability in platform.ts. */
object BridgeCapabilities {
    const val SAVE_URL = "saveUrl"
    const val PIN_SHORTCUT = "pinShortcut"

    fun json(pinSupported: Boolean): String =
        listOfNotNull(SAVE_URL, PIN_SHORTCUT.takeIf { pinSupported })
            .joinToString(",", "[", "]") { "\"$it\"" }
}
