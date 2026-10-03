package io.github.chinmay28.countroster.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineCommandTest {
    @Test
    fun argvFollowsTheLauncherContract() {
        val cmd = EngineCommand(
            binary = "/lib/libcountroster_engine.so",
            dataDir = "/data/engine",
            timezone = "America/Los_Angeles",
            dnsServers = listOf("100.100.100.100", "fe80::1%wlan0"),
        )
        assertEquals(
            listOf(
                "/lib/libcountroster_engine.so",
                "--data-dir", "/data/engine",
                "--host", "127.0.0.1",
                "--port", "0",
                "--tz", "America/Los_Angeles",
                "--dns", "100.100.100.100,fe80::1%wlan0",
            ),
            cmd.argv(),
        )
    }

    @Test
    fun optionalFlagsAreLeftOutWhenUnknown() {
        val argv = EngineCommand("/bin/e", "/d", timezone = "").argv()
        assertFalse(argv.contains("--tz"))
        assertFalse(argv.contains("--dns"))
    }

    @Test
    fun theSecretStaysOffTheCommandLine() {
        val cmd = EngineCommand("/bin/e", "/d", "UTC")
        val secret = Secret.generate()
        assertFalse(cmd.argv().any { it.contains(secret) })
        assertEquals(mapOf("COUNTROSTER_ENGINE_SECRET" to secret), cmd.environment(secret))
    }
}

class ReadyLineTest {
    @Test
    fun readsThePort() {
        assertEquals(41234, ReadyLine.port("""COUNTROSTER_ENGINE_READY {"port":41234,"version":"v2026.10.5","api_level":1}"""))
        assertEquals(8, ReadyLine.port("""COUNTROSTER_ENGINE_READY {"version":"x", "port" : 8}"""))
    }

    @Test
    fun ignoresEverythingElse() {
        assertNull(ReadyLine.port("2026/10/03 12:00:00 [engine] listening on 127.0.0.1:41234"))
        assertNull(ReadyLine.port("""{"port":41234}"""))
        assertNull(ReadyLine.port("COUNTROSTER_ENGINE_READY {}"))
        assertNull(ReadyLine.port("""COUNTROSTER_ENGINE_READY {"port":0}"""))
        assertNull(ReadyLine.port("""COUNTROSTER_ENGINE_READY {"port":99999}"""))
    }
}

class SecretTest {
    @Test
    fun isLongEnoughHexAndFresh() {
        val a = Secret.generate()
        assertEquals(64, a.length) // the engine's gate wants ≥32
        assertTrue(a.all { it in '0'..'9' || it in 'a'..'f' })
        assertFalse(a == Secret.generate())
    }
}

class EndpointTest {
    @Test
    fun cookieAndUrl() {
        val ep = Endpoint(41234, "s3cret")
        assertEquals("http://127.0.0.1:41234", ep.baseUrl)
        assertEquals("cr_session=s3cret; Path=/; HttpOnly; SameSite=Strict", ep.cookie)
        assertFalse("toString must not leak the secret", ep.toString().contains("s3cret"))
    }
}

class EngineClientTest {
    @Test
    fun filenameFromDisposition() {
        assertEquals(
            "countroster-2026-10-03.countroster.zip",
            EngineClient.filenameFromDisposition("attachment; filename=\"countroster-2026-10-03.countroster.zip\""),
        )
        assertEquals("db.sqlite", EngineClient.filenameFromDisposition("attachment; filename=db.sqlite"))
        assertEquals("evil.zip", EngineClient.filenameFromDisposition("attachment; filename=\"../../evil.zip\""))
        assertNull(EngineClient.filenameFromDisposition(null))
        assertNull(EngineClient.filenameFromDisposition("inline"))
    }

    @Test
    fun jsonStringEscapes() {
        assertEquals("\"a\\\"b\\\\c\\u000a\"", EngineClient.jsonString("a\"b\\c\n"))
    }
}
