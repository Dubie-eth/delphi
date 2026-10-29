package site.delphi.nodes

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The card's own PFP oracle (face, role swag, 1/1 body) for the widget, one transparent PNG per status color, drawn by
 * delphi.site/card/<id>/pfp (the same art as the NFT). All status colors are fetched ahead, so a start/stop recolors
 * the widget instantly without a network call. Refreshed daily (a card can become a 1/1 once they're revealed).
 * If nothing is cached yet the widget keeps the plain silhouette.
 */
object PfpCache {
    private const val SIZE = 256
    private const val MAX_AGE_MS = 24 * 60 * 60 * 1000L
    /** every color NodeStatus.color can take */
    private val COLORS = listOf("#22C55E", "#EAB308", "#9CA3AF", "#B91C1C", "#EF4444", "#6B6250")

    private fun hex(color: Int) = String.format("%06x", color and 0xFFFFFF)
    private fun file(ctx: Context, card: Int, color: Int) = File(File(ctx.filesDir, "pfp"), "${card}_${hex(color)}.png")

    /** cached bitmap for this card + color, or null (main thread safe: local file only) */
    fun bitmap(ctx: Context, card: Int, color: Int): Bitmap? {
        val f = file(ctx, card, color)
        return if (f.exists()) runCatching { BitmapFactory.decodeFile(f.path) }.getOrNull() else null
    }

    /** network: fetch any missing or day-old images for this card. Errors are ignored (the silhouette stays). */
    fun prefetch(ctx: Context, card: Int) {
        for (c in COLORS) {
            val color = android.graphics.Color.parseColor(c)
            val f = file(ctx, card, color)
            if (f.exists() && System.currentTimeMillis() - f.lastModified() < MAX_AGE_MS) continue
            runCatching { download("${StatusRepo.SITE}/card/$card/pfp?c=${hex(color)}&size=$SIZE", f) }
        }
    }

    private fun download(url: String, out: File) {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 20_000
        conn.setRequestProperty("User-Agent", "DelphiNodes-Android/${BuildConfig.VERSION_NAME}")
        try {
            if (conn.responseCode !in 200..299) return
            val bytes = conn.inputStream.use { it.readBytes() }
            if (BitmapFactory.decodeByteArray(bytes, 0, bytes.size) == null) return // not an image
            out.parentFile?.mkdirs()
            val tmp = File(out.path + ".tmp")
            tmp.writeBytes(bytes)
            tmp.renameTo(out)
        } finally {
            conn.disconnect()
        }
    }
}
