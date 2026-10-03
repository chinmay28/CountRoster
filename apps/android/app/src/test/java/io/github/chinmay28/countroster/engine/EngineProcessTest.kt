package io.github.chinmay28.countroster.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.util.Collections

/**
 * Drives EngineProcess against a shell script standing in for the engine —
 * the same process mechanics (ready line, stdin lifetime) without Android.
 */
class EngineProcessTest {
    private fun sh(script: String) = listOf("/bin/sh", "-c", script)

    @Test
    fun waitsForTheReadyLineAndLogsTheRest() {
        val logged = Collections.synchronizedList(mutableListOf<String>())
        val p = EngineProcess.start(
            sh("""echo starting; echo oops >&2; echo 'COUNTROSTER_ENGINE_READY {"port":4321}'; cat >/dev/null"""),
            emptyMap(),
            log = { logged.add(it) },
        )
        assertEquals(4321, p.port)
        assertTrue(p.isAlive)
        p.stop()
        assertFalse(p.isAlive)
        assertTrue(logged.contains("starting"))
    }

    @Test
    fun theEngineSeesItsEnvironment() {
        val p = EngineProcess.start(
            sh("""echo "COUNTROSTER_ENGINE_READY {\"port\":${'$'}PORT_FROM_ENV}"; cat >/dev/null"""),
            mapOf("PORT_FROM_ENV" to "777"),
        )
        assertEquals(777, p.port)
        p.stop()
    }

    @Test
    fun closingStdinIsHowTheEngineIsToldToGo() {
        // `cat` exits at EOF, so a graceful stop needs no kill.
        val p = EngineProcess.start(sh("""echo 'COUNTROSTER_ENGINE_READY {"port":1}'; cat >/dev/null; exit 0"""), emptyMap())
        val started = System.nanoTime()
        p.stop(graceMillis = 5_000)
        assertFalse(p.isAlive)
        assertTrue("stop waited for the grace period", System.nanoTime() - started < 4_000_000_000L)
    }

    @Test
    fun anEngineThatDiesEarlyIsAnError() {
        try {
            EngineProcess.start(sh("echo 'bad flag' >&2; exit 2"), emptyMap())
            fail("expected IOException")
        } catch (e: IOException) {
            // Why it failed travels with the error: the status and what it said.
            assertTrue(e.message!!, e.message!!.contains("exited with status 2 before it was ready"))
            assertTrue(e.message!!, e.message!!.contains("bad flag"))
        }
    }

    @Test
    fun anEngineThatNeverAnswersTimesOut() {
        try {
            EngineProcess.start(sh("sleep 30"), emptyMap(), timeoutMillis = 300)
            fail("expected IOException")
        } catch (e: IOException) {
            assertTrue(e.message!!, e.message!!.contains("didn't start"))
        }
    }
}
