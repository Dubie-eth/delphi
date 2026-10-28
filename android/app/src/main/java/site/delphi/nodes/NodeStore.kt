package site.delphi.nodes

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import site.delphi.nodes.core.Approval
import site.delphi.nodes.core.Eth

/**
 * The phone node's own signing key (made on this phone, never leaves it) and the wallet's approval of that key.
 * The key can only sign one card's node reports until the approval expires (max 7 days); it holds no funds.
 */
object NodeStore {
    private const val PREFS = "delphi_node"
    private fun p(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** this phone's session key; made once and reused, so a pending link keeps working */
    fun sessionKey(ctx: Context): ByteArray {
        p(ctx).getString("session_key", null)?.let { return Eth.unhex(it) }
        val k = Eth.newPrivateKey()
        p(ctx).edit().putString("session_key", Eth.hex(k)).apply()
        return k
    }

    fun sessionAddress(ctx: Context) = Eth.address(sessionKey(ctx))

    /** fresh key (e.g. after unlinking): old approvals stop working on this phone */
    fun resetKey(ctx: Context) = p(ctx).edit().remove("session_key").remove("approval").apply()

    fun approval(ctx: Context): Approval? = p(ctx).getString("approval", null)?.let { runCatching { parseJson(JSONObject(it)) }.getOrNull() }

    /** code from delphi.site/node/link: base64url(JSON {v,t,w,k,e,s}). Returns the problem, or null when saved. */
    fun importCode(ctx: Context, raw: String): String? {
        val code = raw.trim().substringAfter("c=").trim()
        val a = runCatching {
            parseJson(JSONObject(String(Base64.decode(code, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), Charsets.UTF_8)))
        }.getOrNull() ?: return "That isn't an approval code from delphi.site/node/link."
        a.problem(sessionAddress(ctx), System.currentTimeMillis() / 1000)?.let { return it }
        p(ctx).edit().putString("approval", JSONObject().put("t", a.tokenId).put("w", a.wallet).put("k", a.key).put("e", a.expires).put("s", a.sig).toString()).apply()
        return null
    }

    private fun parseJson(j: JSONObject) = Approval(j.getInt("t"), j.getString("w"), j.getString("k"), j.getLong("e"), j.getString("s"))

    fun linkUrl(ctx: Context, card: Int?): String =
        "${StatusRepo.SITE}/node/link?key=${sessionAddress(ctx)}" + (card?.let { "&card=$it" } ?: "")

    // live status of the running node, shown by MainActivity and the notification
    fun setStatus(ctx: Context, s: String) = p(ctx).edit().putString("status", s).putLong("status_at", System.currentTimeMillis()).apply()
    fun status(ctx: Context): String = p(ctx).getString("status", "") ?: ""
    fun setRunning(ctx: Context, on: Boolean) = p(ctx).edit().putBoolean("running", on).apply()
    fun running(ctx: Context) = p(ctx).getBoolean("running", false)
    fun batteryOverride(ctx: Context) = p(ctx).getBoolean("battery_override", false)
    fun setBatteryOverride(ctx: Context, on: Boolean) = p(ctx).edit().putBoolean("battery_override", on).apply()
}
