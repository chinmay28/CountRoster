package io.github.chinmay28.countroster.engine

import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.concurrent.thread

/**
 * One engine child process. Its stdin stays open for as long as we want it
 * alive: the engine exits when stdin reaches EOF, so if this app process
 * dies — however it dies — the engine follows it.
 */
class EngineProcess private constructor(
    private val process: Process,
    val port: Int,
) {
    val isAlive: Boolean get() = process.isAlive

    /** Ask the engine to exit (close stdin), and insist if it doesn't. */
    fun stop(graceMillis: Long = 3_000) {
        runCatching { process.outputStream.close() }
        if (!process.waitFor(graceMillis, TimeUnit.MILLISECONDS)) process.destroyForcibly()
    }

    companion object {
        private const val TAIL_LINES = 20

        /**
         * Start the engine and wait for its ready line. [log] receives every
         * other line it prints (stdout and stderr), for Logcat.
         */
        @Throws(IOException::class)
        fun start(
            argv: List<String>,
            environment: Map<String, String>,
            timeoutMillis: Long = 15_000,
            workingDir: java.io.File? = null,
            log: (String) -> Unit = {},
        ): EngineProcess {
            val process = ProcessBuilder(argv).apply {
                environment().putAll(environment)
                workingDir?.let { directory(it) }
            }.start()
            val ready = CompletableFuture<Int>()
            // The last lines the engine printed, so a failure to start can say
            // why — in Logcat, and on the app's error screen.
            val tail = ArrayDeque<String>()
            val record = { line: String ->
                synchronized(tail) {
                    tail.addLast(line)
                    if (tail.size > TAIL_LINES) tail.removeFirst()
                }
                log(line)
            }

            val stderr = thread(isDaemon = true, name = "engine-stderr") {
                runCatching { process.errorStream.bufferedReader().forEachLine(record) }
            }
            thread(isDaemon = true, name = "engine-stdout") {
                try {
                    process.inputStream.bufferedReader().forEachLine { line ->
                        val port = ReadyLine.port(line)
                        if (port != null && !ready.isDone) ready.complete(port) else record(line)
                    }
                } catch (_: IOException) {
                    // stream closed under us — the process is going away
                }
                if (!ready.isDone) {
                    val status = runCatching {
                        if (process.waitFor(2, TimeUnit.SECONDS)) process.exitValue() else null
                    }.getOrNull()
                    stderr.join(1_000)
                    val output = synchronized(tail) { tail.joinToString("\n") }
                    ready.completeExceptionally(
                        IOException(
                            "engine exited${status?.let { " with status $it" } ?: ""} before it was ready" +
                                if (output.isNotEmpty()) ":\n$output" else "",
                        ),
                    )
                }
            }

            try {
                return EngineProcess(process, ready.get(timeoutMillis, TimeUnit.MILLISECONDS))
            } catch (e: TimeoutException) {
                process.destroyForcibly()
                throw IOException("engine didn't start within ${timeoutMillis}ms", e)
            } catch (e: ExecutionException) {
                process.destroyForcibly()
                throw IOException(e.cause?.message ?: "engine failed to start", e.cause)
            }
        }
    }
}
