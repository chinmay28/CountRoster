package io.github.chinmay28.countroster

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.github.chinmay28.countroster.engine.Endpoint
import io.github.chinmay28.countroster.engine.EngineClient
import io.github.chinmay28.countroster.engine.EngineCommand
import io.github.chinmay28.countroster.engine.EngineProcess
import io.github.chinmay28.countroster.engine.Secret
import java.io.File
import java.util.TimeZone
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Owns the engine process for the app's lifetime: starts it on first use,
 * restarts it when it died or the timezone changed, and tells listeners
 * whenever a new one comes up (new port, new secret).
 *
 * Every start/stop runs on one background thread, so there is never more
 * than one engine and callers never block the main thread on it.
 */
class EngineHost private constructor(private val app: Context) {

    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "engine-host") }
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<(Endpoint) -> Unit>()

    // Only touched on the worker thread.
    private var process: EngineProcess? = null
    private var endpoint: Endpoint? = null

    @Volatile
    private var dnsServers: List<String> = emptyList()

    /** Called on the main thread with each newly started engine. */
    fun addListener(listener: (Endpoint) -> Unit) = listeners.add(listener)
    fun removeListener(listener: (Endpoint) -> Unit) = listeners.remove(listener)

    /** Make sure an engine runs; [onReady] / [onError] run on the main thread. */
    fun whenReady(onReady: (Endpoint) -> Unit, onError: (Throwable) -> Unit) {
        worker.execute {
            try {
                val ep = ensureRunning()
                main.post { onReady(ep) }
            } catch (t: Throwable) {
                Log.e(TAG, "engine failed to start", t)
                main.post { onError(t) }
            }
        }
    }

    /** Blocking variant for background work (WorkManager). */
    fun awaitReady(timeoutSeconds: Long = 30): Endpoint =
        worker.submit<Endpoint> { ensureRunning() }.get(timeoutSeconds, TimeUnit.SECONDS)

    /**
     * Replace the engine — after a timezone change, since its zone is fixed
     * at launch (swapping it under running requests would race).
     */
    fun restart() {
        worker.execute {
            stopLocked()
            runCatching { ensureRunning() }.onFailure { Log.e(TAG, "engine restart failed", it) }
        }
    }

    /** New DNS servers for the active network: remembered for the next launch, pushed to a running engine. */
    fun updateDns(servers: List<String>) {
        if (servers == dnsServers) return
        dnsServers = servers
        worker.execute {
            val ep = endpoint ?: return@execute
            if (process?.isAlive != true) return@execute
            runCatching { EngineClient(ep).putDns(servers) }
                .onFailure { Log.w(TAG, "couldn't update the engine's DNS servers", it) }
        }
    }

    private fun ensureRunning(): Endpoint {
        val current = endpoint
        if (current != null && process?.isAlive == true) return current
        stopLocked()

        val command = EngineCommand(
            binary = File(app.applicationInfo.nativeLibraryDir, EngineCommand.BINARY_NAME).path,
            dataDir = File(app.filesDir, "engine").path,
            timezone = TimeZone.getDefault().id,
            dnsServers = dnsServers,
        )
        val secret = Secret.generate()
        val started = EngineProcess.start(command.argv(), command.environment(secret)) { line ->
            Log.i(ENGINE_TAG, line)
        }
        val ep = Endpoint(started.port, secret)
        process = started
        endpoint = ep
        Log.i(TAG, "engine up at $ep")
        main.post { listeners.forEach { it(ep) } }
        return ep
    }

    private fun stopLocked() {
        process?.stop()
        process = null
        endpoint = null
    }

    companion object {
        private const val TAG = "CountRoster"
        private const val ENGINE_TAG = "CountRosterEngine"

        @Volatile
        private var instance: EngineHost? = null

        fun get(context: Context): EngineHost =
            instance ?: synchronized(this) {
                instance ?: EngineHost(context.applicationContext).also { instance = it }
            }
    }
}
