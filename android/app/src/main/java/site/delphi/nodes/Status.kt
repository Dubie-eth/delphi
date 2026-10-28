package site.delphi.nodes

import android.content.Context
import android.graphics.Color
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** One card's status, as served by delphi.site/api/cards/<id>/status (same source as the website's card app). */
data class NodeStatus(val card: Int, val state: String, val label: String, val checkedAt: Long) {
    /** Colors match the website: green running, red not running/not staked, yellow being slashed, gray cooling. */
    val color: Int
        get() = when (state) {
            "running" -> Color.parseColor("#22C55E")
            "slashing" -> Color.parseColor("#EAB308")
            "cooling" -> Color.parseColor("#9CA3AF")
            "slashed" -> Color.parseColor("#B91C1C")
            "idle", "offline" -> Color.parseColor("#EF4444")
            else -> Color.parseColor("#6B6250")
        }
}

object StatusRepo {
    const val SITE = "https://www.delphi.site"
    private const val PREFS = "delphi_nodes"
    private const val STALE_MS = 60 * 60 * 1000L

    fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Network call; run off the main thread. */
    fun fetch(card: Int): NodeStatus {
        val conn = URL("$SITE/api/cards/$card/status").openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 15_000
        conn.setRequestProperty("User-Agent", "DelphiNodes-Android/1")
        conn.setRequestProperty("Accept", "application/json")
        try {
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            val j = JSONObject(body)
            return NodeStatus(card, j.getString("state"), j.getString("label"), System.currentTimeMillis())
        } finally {
            conn.disconnect()
        }
    }

    fun save(ctx: Context, s: NodeStatus) {
        prefs(ctx).edit()
            .putString("card_${s.card}_state", s.state)
            .putString("card_${s.card}_label", s.label)
            .putLong("card_${s.card}_at", s.checkedAt)
            .apply()
    }

    /** Last known status; "Checking…" before the first fetch, "No signal" once it's over an hour old. */
    fun cached(ctx: Context, card: Int): NodeStatus {
        val p = prefs(ctx)
        val at = p.getLong("card_${card}_at", 0L)
        if (at == 0L) return NodeStatus(card, "unknown", "Checking…", 0L)
        val s = NodeStatus(card, p.getString("card_${card}_state", "unknown")!!, p.getString("card_${card}_label", "")!!, at)
        return if (System.currentTimeMillis() - at > STALE_MS) s.copy(state = "unknown", label = "No signal") else s
    }

    // which card each widget shows
    fun setWidgetCard(ctx: Context, widgetId: Int, card: Int) = prefs(ctx).edit().putInt("widget_$widgetId", card).apply()
    fun widgetCard(ctx: Context, widgetId: Int): Int = prefs(ctx).getInt("widget_$widgetId", 0)
    fun removeWidget(ctx: Context, widgetId: Int) = prefs(ctx).edit().remove("widget_$widgetId").apply()
}
