package io.github.chinmay28.countroster

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat

/**
 * Process-wide wiring: the engine host, the signals it has to follow (DNS,
 * timezone), and the background cloud-backup job.
 */
class CountRosterApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val host = EngineHost.get(this)

        DnsWatcher(this, host::updateDns).start()

        // The engine's zone is fixed at launch (Go can't read Android's), so a
        // zone change means a new engine. Open screens reload onto it via
        // EngineHost's listeners.
        ContextCompat.registerReceiver(
            this,
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) = host.restart()
            },
            IntentFilter(Intent.ACTION_TIMEZONE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        CloudBackupWorker.schedule(this)
    }
}
