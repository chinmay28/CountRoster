package io.github.chinmay28.countroster

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.chinmay28.countroster.engine.Endpoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * What only a device can prove: the engine runs when exec'd from the native
 * library directory, it stamps the device's timezone (Go alone would say
 * UTC), it resolves hostnames (Go alone can't on Android), and the WebView
 * renders the app behind the session cookie.
 */
@RunWith(AndroidJUnit4::class)
class AppSmokeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun call(ep: Endpoint, method: String, path: String, body: String? = null): Pair<Int, String> {
        val conn = URL(ep.baseUrl + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.setRequestProperty("Authorization", "Bearer ${ep.secret}")
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(body.toByteArray()) }
        }
        val status = conn.responseCode
        val text = (if (status < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.readText() ?: ""
        conn.disconnect()
        return status to text
    }

    @Test
    fun engineRunsOnTheDeviceInItsTimezone() {
        val ep = EngineHost.get(context).awaitReady()
        assertEquals(200, call(ep, "GET", "/api/health").first)

        val (status, tracker) = call(ep, "POST", "/api/trackers", """{"name":"Smoke","kind":"count"}""")
        assertEquals(tracker, 201, status)
        val offset = ZonedDateTime.now().format(DateTimeFormatter.ofPattern("xxx")) // e.g. -07:00
        assertTrue("created_at in $tracker should carry $offset", tracker.contains("$offset\""))
    }

    @Test
    fun engineResolvesHostnames() {
        val ep = EngineHost.get(context).awaitReady()
        // Give the network callback a moment to hand over the DNS servers.
        Thread.sleep(2_000)
        val (_, body) = call(ep, "POST", "/_engine/sync/probe", """{"url":"http://example.com"}""")
        // example.com answers but isn't CountRoster — reaching that verdict
        // means the name resolved. A DNS failure reads "lookup example.com …".
        assertFalse("DNS failed: $body", body.contains("lookup "))
        assertTrue(body, body.contains("isn't a CountRoster server"))
    }

    @Test
    fun theWebViewRendersTheAppInLocalMode() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val footer = awaitFooter(scenario)
            assertTrue("footer was: $footer", footer.contains("Stored on this device"))

            val caps = evaluate(scenario, "window.CountRosterNative.capabilities()")
            assertTrue(caps, caps.contains("saveUrl"))
        }
    }

    @Test
    fun theAppSurvivesTheWebViewRendererDying() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            assertTrue("app never rendered", awaitFooter(scenario).contains("Stored on this device"))
            // What a renderer crash, or the system reclaiming it, looks like.
            var crashed: Any? = null
            scenario.onActivity {
                crashed = it.webViewForTest
                it.webViewForTest.loadUrl("chrome://crash")
            }
            // Unhandled, Android would kill the app here; handled, a fresh
            // WebView replaces the dead one and reopens the same screen.
            val deadline = System.currentTimeMillis() + 15_000
            var replaced = false
            while (!replaced && System.currentTimeMillis() < deadline) {
                scenario.onActivity { replaced = it.webViewForTest !== crashed }
                if (!replaced) Thread.sleep(100)
            }
            assertTrue("the crashed WebView was never replaced", replaced)
            assertTrue("app didn't recover", awaitFooter(scenario).contains("Stored on this device"))
        }
    }

    private fun awaitFooter(scenario: ActivityScenario<MainActivity>): String {
        val deadline = System.currentTimeMillis() + 30_000
        var footer = ""
        while (System.currentTimeMillis() < deadline) {
            footer = runCatching {
                evaluate(scenario, "(document.querySelector('.app__footer')||{}).textContent||''")
            }.getOrDefault("")
            if (footer.contains("Stored on this device")) break
            Thread.sleep(250)
        }
        return footer
    }

    /** Run [script] in the WebView and return its JSON-encoded result, unquoted. */
    private fun evaluate(scenario: ActivityScenario<MainActivity>, script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        scenario.onActivity { activity ->
            activity.webViewForTest.evaluateJavascript(script) {
                result = it ?: ""
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return result.trim('"').replace("\\\"", "\"")
    }
}
