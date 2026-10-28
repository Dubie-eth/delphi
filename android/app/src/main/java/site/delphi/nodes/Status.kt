package site.delphi.nodes

import android.content.Context
import android.graphics.Color
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** One card's status, as served by delphi.site/api/cards/<id>/status (same source as the website's card app). */
data class NodeStatus(
    val card: Int, val state: String, val label: String, val checkedAt: Long,
    /** staking wallet's points (-1 = unknown) and the node's live checks/s (-1 = not running live) */
    val points: Long = -1, val rate: Double = -1.0,
) {
    /** e.g. "359 c/s · 104,233 pts"; "" when there's nothing to show */
    val statsLine: String
        get() = listOfNotNull(
            if (rate >= 0) "${if (rate >= 10) rate.toLong().toString() else String.format(java.util.Locale.US, "%.1f", rate)} c/s" else null,
            if (points >= 0) "${String.format(java.util.Locale.US, "%,d", points)} pts" else null,
        ).joinToString(" · ")

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

    /** Network call; run off the main thread. Status + points + live rate; falls back to plain status if stats fail. */
    fun fetch(card: Int): NodeStatus =
        try {
            val j = get("$SITE/api/cards/$card/stats")
            NodeStatus(
                card, j.getString("state"), j.getString("label"), System.currentTimeMillis(),
                points = j.optLong("points", -1),
                rate = if (j.isNull("rateLive")) -1.0 else j.optDouble("rateLive", -1.0),
            )
        } catch (e: Exception) {
            val j = get("$SITE/api/cards/$card/status")
            NodeStatus(card, j.getString("state"), j.getString("label"), System.currentTimeMillis())
        }

    private fun get(url: String): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 15_000
        conn.setRequestProperty("User-Agent", "DelphiNodes-Android/1")
        conn.setRequestProperty("Accept", "application/json")
        try {
            val code = conn.responseCode
            val body = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            return JSONObject(body)
        } finally {
            conn.disconnect()
        }
    }

    fun save(ctx: Context, s: NodeStatus) {
        prefs(ctx).edit()
            .putString("card_${s.card}_state", s.state)
            .putString("card_${s.card}_label", s.label)
            .putLong("card_${s.card}_at", s.checkedAt)
            .putLong("card_${s.card}_points", s.points)
            .putFloat("card_${s.card}_rate", s.rate.toFloat())
            .apply()
    }

    /** Last known status; "Checking…" before the first fetch, "No signal" once it's over an hour old. */
    fun cached(ctx: Context, card: Int): NodeStatus {
        val p = prefs(ctx)
        val at = p.getLong("card_${card}_at", 0L)
        if (at == 0L) return NodeStatus(card, "unknown", "Checking…", 0L)
        val s = NodeStatus(
            card, p.getString("card_${card}_state", "unknown")!!, p.getString("card_${card}_label", "")!!, at,
            points = p.getLong("card_${card}_points", -1), rate = p.getFloat("card_${card}_rate", -1f).toDouble(),
        )
        return if (System.currentTimeMillis() - at > STALE_MS) s.copy(state = "unknown", label = "No signal") else s
    }

    // which card each widget shows
    fun setWidgetCard(ctx: Context, widgetId: Int, card: Int) = prefs(ctx).edit().putInt("widget_$widgetId", card).apply()
    fun widgetCard(ctx: Context, widgetId: Int): Int = prefs(ctx).getInt("widget_$widgetId", 0)
    fun removeWidget(ctx: Context, widgetId: Int) = prefs(ctx).edit().remove("widget_$widgetId").apply()
}
