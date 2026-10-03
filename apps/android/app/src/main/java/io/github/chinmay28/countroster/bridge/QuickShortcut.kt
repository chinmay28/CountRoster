package io.github.chinmay28.countroster.bridge

/**
 * Launcher shortcuts to a tracker's quick-log screen — the app's version of
 * bookmarking /trackers/:id/quick. The id charset matches the server's
 * quick-path rule (internal/web), so a shortcut can only ever open that screen.
 */
object QuickShortcut {
    private val idPattern = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val pathPattern = Regex("^/trackers/[A-Za-z0-9_-]{1,64}/quick$")

    /** The quick-log path for [trackerId], or null for an id it can't be. */
    fun path(trackerId: String): String? =
        if (idPattern.matches(trackerId)) "/trackers/$trackerId/quick" else null

    /** Whether a path from an intent may be opened at launch. */
    fun isQuickPath(path: String?): Boolean = path != null && pathPattern.matches(path)

    fun shortcutId(trackerId: String) = "quick-$trackerId"

    /** Launchers truncate long labels anyway; keep it to something legible. */
    fun label(name: String): String = name.trim().ifEmpty { "CountRoster" }.take(25)

    /** The glyph drawn on the icon: the name's first letter or digit. */
    fun initial(name: String): String {
        val first = name.trim().firstOrNull { it.isLetterOrDigit() } ?: return "#"
        return first.uppercaseChar().toString()
    }

    /** "#rgb" / "#rrggbb" → opaque ARGB, or null. */
    fun parseColor(hex: String): Int? {
        val h = hex.trim().removePrefix("#")
        val full = when (h.length) {
            3 -> h.map { "$it$it" }.joinToString("")
            6 -> h
            else -> return null
        }
        val rgb = full.toLongOrNull(16) ?: return null
        return (0xFF000000L or rgb).toInt()
    }
}
