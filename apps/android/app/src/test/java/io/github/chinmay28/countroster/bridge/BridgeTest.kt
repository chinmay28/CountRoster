package io.github.chinmay28.countroster.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeMessagesTest {
    @Test
    fun parsesWhatPlatformTsSends() {
        val req = BridgeRequest.parse("""{"id":7,"method":"saveUrl","args":{"path":"/api/backup/bundle","suggestedName":"x.zip"}}""")!!
        assertEquals(7, req.id)
        assertEquals("saveUrl", req.method)
        assertEquals("/api/backup/bundle", req.string("path"))
        assertNull(req.string("missing"))
    }

    @Test
    fun rejectsGarbage() {
        assertNull(BridgeRequest.parse("not json"))
        assertNull(BridgeRequest.parse("""{"method":"saveUrl"}"""))
        assertEquals(0, BridgeRequest.parse("""{"id":1,"method":"x"}""")!!.args.length())
    }

    @Test
    fun replyScriptsAreSafeJavaScript() {
        assertEquals(
            "window.__countrosterNativeReply && window.__countrosterNativeReply(3, true, true);",
            BridgeReply.script(3, true, true),
        )
        val script = BridgeReply.script(4, false, "it's \"broken\"</script>")
        assertTrue(script, script.contains("""(4, false, "it's \"broken\"<\/script>")"""))
        assertTrue(BridgeReply.script(5, true, null).endsWith("(5, true, null);"))
    }

    @Test
    fun capabilitiesMatchThePlatform() {
        assertEquals("""["saveUrl","pinShortcut"]""", BridgeCapabilities.json(pinSupported = true))
        assertEquals("""["saveUrl"]""", BridgeCapabilities.json(pinSupported = false))
    }
}

class QuickShortcutTest {
    @Test
    fun onlyEverOpensAQuickLogScreen() {
        assertEquals("/trackers/019f97b1-ab_c/quick", QuickShortcut.path("019f97b1-ab_c"))
        assertNull(QuickShortcut.path("../data"))
        assertNull(QuickShortcut.path(""))
        assertNull(QuickShortcut.path("x".repeat(65)))
        assertTrue(QuickShortcut.isQuickPath("/trackers/abc/quick"))
        assertFalse(QuickShortcut.isQuickPath("/data"))
        assertFalse(QuickShortcut.isQuickPath("https://evil.example/trackers/abc/quick"))
        assertFalse(QuickShortcut.isQuickPath(null))
    }

    @Test
    fun labelsAndInitials() {
        assertEquals("CountRoster", QuickShortcut.label("   "))
        assertEquals(25, QuickShortcut.label("A".repeat(40)).length)
        assertEquals("P", QuickShortcut.initial("  papu feed log"))
        assertEquals("7", QuickShortcut.initial("7-minute workout"))
        assertEquals("#", QuickShortcut.initial("🙂"))
    }

    @Test
    fun colors() {
        assertEquals(0xFFFF5CA8.toInt(), QuickShortcut.parseColor("#ff5ca8"))
        assertEquals(0xFF112233.toInt(), QuickShortcut.parseColor("#123"))
        assertNull(QuickShortcut.parseColor("red"))
        assertNull(QuickShortcut.parseColor("#12345"))
    }
}
