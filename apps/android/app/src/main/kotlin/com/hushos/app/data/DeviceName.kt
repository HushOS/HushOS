package com.hushos.app.data

/*
 * What this phone calls itself in the device list: its maker and model as the system reports them
 * (`Build.MANUFACTURER`, `Build.MODEL`), "Pixel 9" or "Samsung SM-S931B". Never the name the owner
 * gave the phone (`Settings.Global.DEVICE_NAME`, the Bluetooth name): those often carry the owner's
 * own name. Android has no permission-free way to read a marketing name, and Samsung's model is a
 * code, so a Galaxy shows its code rather than a name from a table someone has to keep up.
 *
 * The result always passes the server's rule (`normalizeDeviceName` in packages/auth/src/server.ts):
 * 1 to 40 letters, marks, numbers, spaces and `'’()._·-`.
 */
object DeviceName {
    const val MAX = 40
    private val REFUSED = Regex("[^\\p{L}\\p{M}\\p{N} '’()._·-]+")
    private val SPACES = Regex("\\s+")

    fun of(manufacturer: String?, model: String?, tablet: Boolean): String {
        val fallback = if (tablet) "Android tablet" else "Android phone"
        val maker = clean(manufacturer.orEmpty())
        val product = clean(model.orEmpty())
        if (product.isEmpty()) return fallback
        val named = when {
            maker.isEmpty() -> product
            // Google's models are already the product's name: "Pixel 9", never "Google Pixel 9".
            maker.equals("Google", ignoreCase = true) -> product
            product.startsWith(maker, ignoreCase = true) -> product
            else -> "${titled(maker)} $product"
        }
        return cut(named)
    }

    /* Anything the server refuses becomes a space, then runs of spaces become one. */
    private fun clean(value: String) = value.replace(REFUSED, " ").replace(SPACES, " ").trim()

    /* "samsung" becomes "Samsung"; a maker that already uses capitals ("OnePlus", "HMD Global") is left alone. */
    private fun titled(maker: String) =
        if (maker != maker.lowercase()) maker
        else maker.split(' ').joinToString(" ") { word -> word.replaceFirstChar { it.titlecase() } }

    /* At most MAX characters as the server counts them (code points). */
    private fun cut(name: String): String {
        if (name.codePointCount(0, name.length) <= MAX) return name
        return name.substring(0, name.offsetByCodePoints(0, MAX)).trim()
    }
}
