package io.github.chinmay28.countroster

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.github.chinmay28.countroster.bridge.BridgeReply
import io.github.chinmay28.countroster.bridge.BridgeRequest
import io.github.chinmay28.countroster.bridge.NativeBridge
import io.github.chinmay28.countroster.bridge.QuickShortcut
import io.github.chinmay28.countroster.bridge.ShortcutPinner
import io.github.chinmay28.countroster.engine.Endpoint
import io.github.chinmay28.countroster.engine.EngineClient
import java.io.File
import kotlin.concurrent.thread

/**
 * The whole UI: a WebView showing the web client, served by the on-device
 * engine. Everything the browser can't do (save a file, pin a shortcut) goes
 * through [NativeBridge]; everything else is the PWA, unchanged.
 */
class MainActivity : ComponentActivity(), NativeBridge.Host {

    private lateinit var webView: WebView

    /** For instrumented tests only. */
    internal val webViewForTest: WebView get() = webView
    private lateinit var errorView: LinearLayout
    private val engine by lazy { EngineHost.get(this) }

    /** The engine the WebView is pointed at. */
    private var endpoint: Endpoint? = null

    /** A path to open once the engine is up (a shortcut's quick-log screen). */
    private var pendingPath: String? = null

    private var fileChooser: ValueCallback<Array<Uri>>? = null

    private class PendingSave(val id: Int, val file: File)

    private var pendingSave: PendingSave? = null

    private val onNewEngine: (Endpoint) -> Unit = { attach(it) }

    private val openDocument =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            fileChooser?.onReceiveValue(uri?.let { arrayOf(it) })
            fileChooser = null
        }

    private val createDocument =
        registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) {
            finishSave(it)
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        val ink = ContextCompat.getColor(this, R.color.countroster_ink)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView = WebView(this).apply {
            setBackgroundColor(ink)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportMultipleWindows(false)
            webViewClient = EngineOnlyClient()
            webChromeClient = FileChooserClient()
            addJavascriptInterface(NativeBridge(this@MainActivity), "CountRosterNative")
        }
        errorView = buildErrorView()

        val root = FrameLayout(this).apply {
            setBackgroundColor(ink)
            addView(webView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(errorView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        // Edge to edge: keep the page clear of the status bar, the navigation
        // bar, cutouts, and the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        pendingPath = startPath(intent)
    }

    override fun onStart() {
        super.onStart()
        engine.addListener(onNewEngine)
        connect()
    }

    override fun onResume() {
        super.onResume()
        // Also flips the page's visibilityState, which is what makes the web
        // client refresh after time in the background.
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onStop() {
        engine.removeListener(onNewEngine)
        super.onStop()
    }

    override fun onDestroy() {
        fileChooser?.onReceiveValue(null)
        webView.destroy()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val path = startPath(intent) ?: return
        val ep = endpoint
        if (ep != null) webView.loadUrl(ep.baseUrl + path) else pendingPath = path
    }

    private fun startPath(intent: Intent?): String? =
        intent?.getStringExtra(EXTRA_PATH)?.takeIf(QuickShortcut::isQuickPath)

    private fun connect() {
        engine.whenReady(::attach) { showError() }
    }

    /** Point the WebView at [ep] — first launch, or a replacement engine. */
    private fun attach(ep: Endpoint) {
        if (ep == endpoint) return
        val path = pendingPath ?: currentPath() ?: "/"
        pendingPath = null
        endpoint = ep
        errorView.visibility = android.view.View.GONE
        val cookies = CookieManager.getInstance()
        cookies.setCookie(ep.baseUrl, ep.cookie) {
            cookies.flush()
            webView.loadUrl(ep.baseUrl + path)
        }
    }

    /** Where the WebView is now, so a new engine reopens the same screen. */
    private fun currentPath(): String? {
        val uri = webView.url?.let(Uri::parse) ?: return null
        if (uri.host != ENGINE_HOST) return null
        val query = uri.encodedQuery?.let { "?$it" } ?: ""
        return (uri.encodedPath ?: "/") + query
    }

    private fun showError() {
        errorView.visibility = android.view.View.VISIBLE
    }

    private fun buildErrorView(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        visibility = android.view.View.GONE
        val pad = (24 * resources.displayMetrics.density).toInt()
        setPadding(pad, pad, pad, pad)
        addView(TextView(context).apply {
            setText(R.string.engine_failed)
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        addView(Button(context).apply {
            setText(R.string.retry)
            setOnClickListener { connect() }
        }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
    }

    /** Keeps the WebView on the engine's origin; any other link opens outside. */
    private inner class EngineOnlyClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.host == ENGINE_HOST) return false
            try {
                startActivity(Intent(Intent.ACTION_VIEW, url))
            } catch (_: ActivityNotFoundException) {
                // nothing can open it; stay put
            }
            return true
        }
    }

    /** `<input type="file">` (restoring a backup, importing transactions). */
    private inner class FileChooserClient : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            fileChooser?.onReceiveValue(null)
            fileChooser = callback
            return try {
                // Any type: a .countroster.zip often reports as octet-stream,
                // and a MIME filter would hide it. The server validates.
                openDocument.launch(arrayOf("*/*"))
                true
            } catch (_: ActivityNotFoundException) {
                fileChooser = null
                false
            }
        }
    }

    // --- NativeBridge.Host ---------------------------------------------------

    override fun pinSupported() = ShortcutPinner.isSupported(this)

    override fun saveUrl(request: BridgeRequest) {
        val ep = endpoint ?: return reply(request.id, false, "The app isn't ready yet.")
        val path = request.string("path") ?: return reply(request.id, false, "Nothing to save.")
        if (pendingSave != null) return reply(request.id, false, "Another save is in progress.")
        val suggested = request.string("suggestedName") ?: "countroster-backup"
        thread(name = "save-url") {
            try {
                val tmp = File.createTempFile("save-", ".tmp", cacheDir)
                val name = EngineClient(ep).download(path, tmp) ?: suggested
                runOnUiThread {
                    pendingSave = PendingSave(request.id, tmp)
                    try {
                        createDocument.launch(name)
                    } catch (_: ActivityNotFoundException) {
                        pendingSave = null
                        tmp.delete()
                        reply(request.id, false, "No app on this device can save files.")
                    }
                }
            } catch (e: Exception) {
                runOnUiThread { reply(request.id, false, e.message ?: "Download failed.") }
            }
        }
    }

    private fun finishSave(uri: Uri?) {
        val save = pendingSave ?: return
        pendingSave = null
        if (uri == null) {
            save.file.delete()
            reply(save.id, true, false) // cancelled
            return
        }
        thread(name = "save-url-write") {
            val result = runCatching {
                val out = contentResolver.openOutputStream(uri) ?: error("Couldn't open the file.")
                out.use { o -> save.file.inputStream().use { it.copyTo(o) } }
            }
            save.file.delete()
            runOnUiThread {
                result.fold(
                    onSuccess = { reply(save.id, true, true) },
                    onFailure = { reply(save.id, false, it.message ?: "Couldn't write the file.") },
                )
            }
        }
    }

    override fun pinShortcut(request: BridgeRequest) {
        val id = request.string("id") ?: return reply(request.id, false, "No tracker.")
        val pinned = ShortcutPinner.pin(this, id, request.string("name") ?: "", request.string("color") ?: "")
        reply(request.id, true, pinned)
    }

    override fun reply(id: Int, ok: Boolean, value: Any?) {
        webView.evaluateJavascript(BridgeReply.script(id, ok, value), null)
    }

    companion object {
        const val EXTRA_PATH = "io.github.chinmay28.countroster.PATH"
        private const val ENGINE_HOST = "127.0.0.1"
    }
}
