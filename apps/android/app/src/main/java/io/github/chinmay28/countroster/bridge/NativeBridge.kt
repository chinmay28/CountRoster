package io.github.chinmay28.countroster.bridge

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface

/**
 * `window.CountRosterNative` — the host half of apps/web/src/lib/platform.ts.
 *
 * The WebView calls these on its own background thread; requests are moved
 * to the main thread before anything touches the UI. Every request gets a
 * reply through [Host.reply], including unknown methods, so no promise on the
 * web side is left hanging.
 *
 * Exposure: a JavaScript interface is visible to whatever page the WebView
 * shows, which is why MainActivity only ever navigates the WebView within
 * the engine's own origin and sends every other URL to the browser.
 */
class NativeBridge(private val host: Host) {
    interface Host {
        fun pinSupported(): Boolean
        fun saveUrl(request: BridgeRequest)
        fun pinShortcut(request: BridgeRequest)
        fun reply(id: Int, ok: Boolean, value: Any?)
    }

    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun capabilities(): String = BridgeCapabilities.json(host.pinSupported())

    @JavascriptInterface
    fun postMessage(json: String) {
        val request = BridgeRequest.parse(json) ?: return
        main.post {
            when (request.method) {
                BridgeCapabilities.SAVE_URL -> host.saveUrl(request)
                BridgeCapabilities.PIN_SHORTCUT -> host.pinShortcut(request)
                else -> host.reply(request.id, false, "unknown method ${request.method}")
            }
        }
    }
}
