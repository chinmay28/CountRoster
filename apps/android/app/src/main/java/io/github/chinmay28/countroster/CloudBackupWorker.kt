package io.github.chinmay28.countroster

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import io.github.chinmay28.countroster.engine.EngineClient
import java.util.concurrent.TimeUnit

/**
 * The engine's cloud-backup scheduler only ticks while its process runs.
 * This job gives it a tick every hour or so even when the app isn't open;
 * the run itself is decided by `next_run_at` in the database, so a missed
 * tick just means the backup happens on the next one. In sync mode the tick
 * is a no-op — the server runs its own backups.
 */
class CloudBackupWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = try {
        val endpoint = EngineHost.get(applicationContext).awaitReady()
        EngineClient(endpoint).cloudTick()
        Result.success()
    } catch (e: Exception) {
        Log.w("CountRoster", "cloud backup tick failed", e)
        Result.retry()
    }

    companion object {
        private const val NAME = "cloud-backup-tick"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<CloudBackupWorker>(1, TimeUnit.HOURS)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
