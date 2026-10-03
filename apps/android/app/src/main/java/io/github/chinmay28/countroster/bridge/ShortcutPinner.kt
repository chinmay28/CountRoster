package io.github.chinmay28.countroster.bridge

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import io.github.chinmay28.countroster.MainActivity

/** Pins a launcher shortcut to a tracker's quick-log screen. */
object ShortcutPinner {
    fun isSupported(context: Context) = ShortcutManagerCompat.isRequestPinShortcutSupported(context)

    /**
     * Ask the launcher to pin it. True means the launcher took the request —
     * it then asks the person to confirm, which this can't observe.
     */
    fun pin(context: Context, trackerId: String, name: String, color: String): Boolean {
        val path = QuickShortcut.path(trackerId) ?: return false
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(MainActivity.EXTRA_PATH, path)
        val info = ShortcutInfoCompat.Builder(context, QuickShortcut.shortcutId(trackerId))
            .setShortLabel(QuickShortcut.label(name))
            .setLongLabel(name.trim().ifEmpty { QuickShortcut.label(name) })
            .setIcon(IconCompat.createWithAdaptiveBitmap(icon(context, name, color)))
            .setIntent(intent)
            .build()
        return ShortcutManagerCompat.requestPinShortcut(context, info, null)
    }

    /** The tracker's color with its initial — an adaptive icon's full 108dp canvas. */
    private fun icon(context: Context, name: String, color: String): Bitmap {
        val size = (108 * context.resources.displayMetrics.density).toInt().coerceAtLeast(108)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val background = QuickShortcut.parseColor(color) ?: Color.parseColor("#1F2933")
        canvas.drawColor(background)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = if (luminance(background) > 0.6) Color.parseColor("#1F2933") else Color.WHITE
            textAlign = Paint.Align.CENTER
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            textSize = size * 0.36f // inside the 66dp safe zone
        }
        val y = size / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(QuickShortcut.initial(name), size / 2f, y, paint)
        return bitmap
    }

    private fun luminance(argb: Int): Double =
        (0.299 * Color.red(argb) + 0.587 * Color.green(argb) + 0.114 * Color.blue(argb)) / 255.0
}
