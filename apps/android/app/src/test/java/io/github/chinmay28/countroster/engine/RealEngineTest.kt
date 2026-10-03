package io.github.chinmay28.countroster.engine

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.util.zip.ZipFile

/**
 * The Kotlin launcher against the real Go engine — a host-native build of
 * the same code the phone runs (scripts/build-android.sh makes it). Skipped
 * until the engine has been built.
 */
class RealEngineTest {
    private val binary = File(
        System.getProperty("countroster.engineBinary") ?: "build/host-engine/countroster-engine",
    )
    private lateinit var dataDir: File
    private var process: EngineProcess? = null

    @Before
    fun setUp() {
        assumeTrue("build the engine first (scripts/build-android.sh)", binary.canExecute())
        dataDir = Files.createTempDirectory("engine").toFile()
    }

    @After
    fun tearDown() {
        process?.stop()
        if (::dataDir.isInitialized) dataDir.deleteRecursively()
    }

    private fun start(): Endpoint {
        val cmd = EngineCommand(binary.path, dataDir.path, "America/Los_Angeles", listOf("1.1.1.1"))
        val secret = Secret.generate()
        val p = EngineProcess.start(cmd.argv(), cmd.environment(secret))
        process = p
        return Endpoint(p.port, secret)
    }

    private fun get(ep: Endpoint, path: String, bearer: Boolean = true): Pair<Int, String> {
        val conn = URL(ep.baseUrl + path).openConnection() as HttpURLConnection
        if (bearer) conn.setRequestProperty("Authorization", "Bearer ${ep.secret}")
        val status = conn.responseCode
        val body = (if (status < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.readText() ?: ""
        conn.disconnect()
        return status to body
    }

    @Test
    fun launchesAndServesBehindItsSecret() {
        val ep = start()
        val (status, body) = get(ep, "/api/health")
        assertEquals(200, status)
        assertTrue(body, body.contains("\"api_level\""))
        assertEquals(403, get(ep, "/api/health", bearer = false).first)

        val (s, engine) = get(ep, "/_engine/status")
        assertEquals(200, s)
        assertTrue(engine, engine.contains("\"mode\":\"local\""))
    }

    @Test
    fun theShellsOwnCallsWork() {
        val ep = start()
        val client = EngineClient(ep)
        client.putDns(listOf("100.100.100.100", "192.168.1.1"))
        client.cloudTick()

        val dest = File(dataDir, "bundle.zip")
        val name = client.download("/api/backup/bundle", dest)
        assertTrue("suggested name: $name", name!!.endsWith(".countroster.zip"))
        // ZipFile, not ZipInputStream: the bundle's entries are stored with
        // data descriptors, which Java's streaming reader can't walk.
        val entries = ZipFile(dest).use { zip -> zip.entries().toList().map { it.name } }
        assertTrue(entries.toString(), entries.contains("manifest.json"))
    }

    @Test
    fun dataSurvivesARestart() {
        var ep = start()
        val conn = URL(ep.baseUrl + "/api/trackers").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Authorization", "Bearer ${ep.secret}")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write("""{"name":"Water","kind":"count"}""".toByteArray()) }
        assertEquals(201, conn.responseCode)
        conn.disconnect()

        process!!.stop()
        ep = start() // new port, new secret, same data directory
        assertTrue(get(ep, "/api/trackers").second.contains("\"Water\""))
    }
}
