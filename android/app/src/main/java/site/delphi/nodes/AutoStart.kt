package site.delphi.nodes

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import site.delphi.nodes.core.Eth
import site.delphi.nodes.core.Protocol
import java.util.concurrent.TimeUnit

/**
 * Keeps the phone node running when the user wants it running: after it paused for low battery (restarts once the phone
 * is charging or back above 30 %), after Android killed it, and after a reboot or app update. "Wants it running" means
 * the user pressed Start and hasn't pressed Stop. Checks run from a 15-minute background job, the widget refresh
 * (about every minute while the screen is on) and boot. If Android won't let the app start it from the background, a
 * notification asks for one tap instead.
 */
object AutoStart {
    private const val CHANNEL = "delphi-node-restart"
    private const val NOTE_ID = 46631
    private const val PERIODIC = "delphi-node-autostart"

    fun batteryBlocked(ctx: Context): Boolean {
        val b = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return false
        val level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return false
        val st = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL
        return Protocol.shouldPauseForBattery(level.toDouble() / scale, charging, NodeStore.batteryOverride(ctx))
    }

    fun schedule(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<Check>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /** start the node if the user wants it running and nothing stops it; returns true if it started (or tried) */
    fun check(ctx: Context): Boolean {
        if (!NodeStore.wantRunning(ctx) || !NodeStore.autoRestart(ctx) || NodeStore.reallyRunning(ctx)) return false
        if (NodeStore.running(ctx)) NodeStore.setRunning(ctx, false) // stale flag: Android killed the service
        val a = NodeStore.approval(ctx) ?: return false
        val problem = a.problem(Eth.address(NodeStore.sessionKey(ctx)), System.currentTimeMillis() / 1000)
        if (problem != null) {
            notifyTap(ctx, "Your node's approval ran out", "Tap to link again and keep earning points.")
            NodeStore.setWantRunning(ctx, false)
            return false
        }
        if (batteryBlocked(ctx)) return false
        return try {
            NodeService.start(ctx)
            cancelNote(ctx)
            true
        } catch (e: Exception) { // Android 12+: no background starts unless battery is "Unrestricted"
            notifyTap(ctx, "Restart your Delphi node", "It stopped and Android needs one tap to start it again.")
            false
        }
    }

    private fun notifyTap(ctx: Context, title: String, text: String) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Node restarts", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            ctx, 2, Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_RESTART).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val b = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(ctx, CHANNEL) else @Suppress("DEPRECATION") android.app.Notification.Builder(ctx)
        runCatching {
            nm.notify(NOTE_ID, b.setSmallIcon(R.drawable.silhouette).setContentTitle(title).setContentText(text).setContentIntent(open).setAutoCancel(true).build())
        }
    }

    fun cancelNote(ctx: Context) = ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTE_ID)

    class Check(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
        override suspend fun doWork(): Result {
            runCatching { check(applicationContext) }
            return Result.success()
        }
    }

    /** reboot / app update: both may start a foreground service from the background */
    class Boot : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
            if (NodeStore.wantRunning(ctx)) schedule(ctx)
            NodeStore.setRunning(ctx, false) // a reboot ended any previous run
            check(ctx)
        }
    }
}
