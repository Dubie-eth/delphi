package site.delphi.nodes

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONObject
import site.delphi.nodes.core.Approval
import site.delphi.nodes.core.Eth
import site.delphi.nodes.core.Freivalds
import site.delphi.nodes.core.Protocol
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * The phone node, running in the background (foreground service + partial wake lock), so it keeps working with the
 * screen off or while other apps are open. Same work and reports as delphi.site/node:
 *  - each batch is anchored to the latest side-chain block; its hash seeds the Freivalds matrices (the attestor
 *    recomputes the result hash from the same seed),
 *  - every 10 min a batch is signed with this phone's session key and sent to /api/node-results,
 *  - every minute a heartbeat goes to /api/cards/<id>/live (the card and widget show "Running"),
 *  - pauses below 30 % battery unless charging (same rule as the web node), and stops when the approval runs out.
 */
class NodeService : Service() {
    companion object {
        private const val CHANNEL = "delphi-node"
        private const val NOTE_ID = 46630
        const val ACTION_STOP = "site.delphi.nodes.STOP"
        const val N = 512

        fun start(ctx: Context) {
            val i = Intent(ctx, NodeService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) = ctx.startService(Intent(ctx, NodeService::class.java).setAction(ACTION_STOP))
    }

    private val running = AtomicBoolean(false)
    private val checks = AtomicLong(0)
    private var worker: Thread? = null
    private var sched: ScheduledExecutorService? = null
    private var wake: PowerManager.WakeLock? = null
    private lateinit var approval: Approval
    private lateinit var key: ByteArray
    @Volatile private var lastBeat: Pair<Long, Long>? = null // checks, millis
    @Volatile private var rateNow = 0.0
    @Volatile private var lastBatch = "no batch yet"
    @Volatile private var problem: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown("Stopped.")
            return START_NOT_STICKY
        }
        if (running.get()) return START_STICKY
        startForegroundNow("Starting…")
        val a = NodeStore.approval(this)
        key = NodeStore.sessionKey(this)
        val why = a?.problem(Eth.address(key), System.currentTimeMillis() / 1000) ?: if (a == null) "Link your wallet first." else null
        if (a == null || why != null) {
            shutdown(why ?: "Link your wallet first.")
            return START_NOT_STICKY
        }
        if (batteryBlocked()) {
            shutdown("Paused: battery under 30 % and not charging.")
            return START_NOT_STICKY
        }
        approval = a
        running.set(true)
        NodeStore.setRunning(this, true)
        wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "delphi:node").apply { acquire() }
        worker = Thread({ workLoop() }, "delphi-node").apply { priority = Thread.NORM_PRIORITY - 1; start() }
        sched = Executors.newSingleThreadScheduledExecutor().apply {
            scheduleWithFixedDelay({ runCatching { minuteTick() } }, 5, Protocol.HEARTBEAT_MS / 1000, TimeUnit.SECONDS)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        if (running.get()) shutdown("Stopped.")
        super.onDestroy()
    }

    // ---- work: batches of Freivalds checks, each anchored to a fresh block ----
    private fun workLoop() {
        while (running.get()) {
            val block = try {
                Net.latestBlock()
            } catch (e: Exception) {
                status("Can't reach the side chain (${e.message?.take(60)}); retrying…"); sleepQuiet(15_000); continue
            }
            val seed = Protocol.seedFromAnchor(block.hash, approval.tokenId, approval.wallet)
            val m = Freivalds.build(seed, N)
            val rng = Freivalds.checkRng(seed)
            val r = IntArray(N); val br = LongArray(N)
            val startMs = System.currentTimeMillis()
            val startChecks = checks.get()
            var failures = 0
            while (running.get() && System.currentTimeMillis() - startMs < Protocol.BATCH_MS) {
                if (!Freivalds.check(m, rng, r, br)) failures++
                checks.incrementAndGet()
            }
            val n = checks.get() - startChecks
            if (n > 0) submitBatch(block, m.resultHash, n, (System.currentTimeMillis() - startMs) / 1000, failures)
        }
    }

    private fun submitBatch(block: Net.Block, resultHash: String, n: Long, durationSec: Long, failures: Int) {
        val ts = System.currentTimeMillis() / 1000
        if (ts - block.timestamp > Protocol.ANCHOR_MAX_AGE_SEC + Protocol.BATCH_MS / 1000) {
            lastBatch = "skipped a batch: its block got too old (phone slept?)"; return
        }
        val dur = maxOf(1L, durationSec)
        val msg = Protocol.batchMessage(approval.tokenId, resultHash, n, dur, ts, block.number, N)
        val body = JSONObject()
            .put("sig", Eth.signPersonal(key, msg))
            .put("sessionKey", Eth.address(key)).put("sessionExpires", approval.expires).put("sessionSig", approval.sig)
            .put("tokenId", approval.tokenId).put("wallet", approval.wallet).put("resultHash", resultHash)
            .put("checks", n).put("durationSec", dur).put("ts", ts).put("anchorBlock", block.number).put("n", N)
            .put("label", "android").put("userAgent", "DelphiNodes-Android/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; ${Build.MODEL})")
            .put("cores", Runtime.getRuntime().availableProcessors())
            .put("stats", JSONObject().put("tileSize", N).put("checks", n).put("failures", failures).put("checksPerSec", Math.round(n * 10.0 / dur) / 10.0).put("resultHash", resultHash).put("elapsedSec", dur))
        val at = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date())
        lastBatch = try {
            val (code, j) = Net.post("${StatusRepo.SITE}/api/node-results", body)
            if (code in 200..299) "batch sent at $at ($n checks)" else "batch refused at $at: ${j.optString("error", "HTTP $code")}"
        } catch (e: Exception) {
            "batch not sent at $at: ${e.message?.take(60)}"
        }
        refreshNotification()
    }

    // ---- every minute: heartbeat, battery, approval expiry, notification ----
    private fun minuteTick() {
        val now = System.currentTimeMillis()
        val c = checks.get()
        lastBeat?.let { (pc, pt) -> if (now > pt) rateNow = (c - pc) * 1000.0 / (now - pt) }
        lastBeat = c to now
        if (batteryBlocked()) { shutdown("Paused: battery under 30 % and not charging."); return }
        if (approval.expires - now / 1000 < 15 * 60) { shutdown("Approval ran out. Link your wallet again (7 days per approval)."); return }
        heartbeat(true)
        refreshNotification()
    }

    private fun heartbeat(on: Boolean) {
        val ts = System.currentTimeMillis() / 1000
        val rate100 = if (on) Math.round(rateNow * 100).coerceIn(0, 10_000_000) else 0
        val sig = Eth.signPersonal(key, Protocol.liveMessage(approval.tokenId, approval.wallet, on, ts, rate100))
        val body = JSONObject().put("wallet", approval.wallet).put("running", on).put("ts", ts).put("rate100", rate100)
            .put("sig", sig).put("sessionKey", Eth.address(key)).put("sessionExpires", approval.expires).put("sessionSig", approval.sig)
        val before = liveShown
        problem = try {
            val (code, j) = Net.post("${StatusRepo.SITE}/api/cards/${approval.tokenId}/live", body)
            if (code in 200..299) null else "card status not updated: ${j.optString("error", "HTTP $code")}"
        } catch (e: Exception) {
            "no connection"
        }
        // the card just turned green (or red on stop): redraw the widget now instead of waiting for its next refresh
        liveShown = problem == null && on
        if (liveShown != before || !on) RefreshWorker.runNow(this)
    }
    @Volatile private var liveShown = false

    private fun batteryBlocked(): Boolean {
        val b = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return false
        val level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return false
        val st = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL
        return Protocol.shouldPauseForBattery(level.toDouble() / scale, charging, NodeStore.batteryOverride(this))
    }

    // ---- lifecycle / notification ----
    private fun shutdown(reason: String) {
        val wasRunning = running.getAndSet(false)
        sched?.shutdownNow(); sched = null
        if (wasRunning) Thread { runCatching { heartbeat(false) } }.apply { start(); join(8000) }
        worker?.interrupt(); worker = null
        runCatching { if (wake?.isHeld == true) wake?.release() }
        NodeStore.setRunning(this, false)
        status(reason)
        RefreshWorker.runNow(this)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun status(s: String) {
        NodeStore.setStatus(this, s)
    }

    private fun summary(): String {
        val card = if (::approval.isInitialized) "Card #${approval.tokenId}" else "Delphi node"
        val rate = if (rateNow > 0) " · ${if (rateNow >= 10) rateNow.toLong() else "%.1f".format(rateNow)} checks/s" else ""
        val shown = if (problem == null && liveShown) "\nCard shows Running on delphi.site and your widget" else ""
        return "$card running$rate\nTotal ${checks.get()} checks · $lastBatch$shown" + (problem?.let { "\n$it" } ?: "")
    }

    private fun refreshNotification() {
        if (!running.get()) return // a final batch sent after Stop must not bring the notification back
        val s = summary()
        status(s)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTE_ID, note(s))
    }

    private fun note(text: String): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Delphi node", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, NodeService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        return b.setSmallIcon(R.drawable.silhouette)
            .setContentTitle(text.lineSequence().first())
            .setContentText(text.lineSequence().drop(1).joinToString(" · "))
            .setStyle(Notification.BigTextStyle().bigText(text.lineSequence().drop(1).joinToString("\n")))
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun startForegroundNow(text: String) {
        val n = note(text)
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTE_ID, n)
    }

    private fun sleepQuiet(ms: Long) = try { Thread.sleep(ms) } catch (_: InterruptedException) {}
}
