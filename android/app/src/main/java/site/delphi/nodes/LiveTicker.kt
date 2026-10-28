package site.delphi.nodes

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock

/** Refreshes the widgets about once a minute while the phone is awake, so a node's Start/Stop shows within a minute.
 *  Uses a non-waking alarm: with the screen off it never wakes the phone (no battery cost); the pending refresh runs as
 *  soon as the phone wakes, so the widget is current when you look at it. The 15-minute WorkManager job restarts this
 *  chain after a reboot or app update. */
class LiveTicker : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (NodeWidgetProvider.widgetIds(ctx).isEmpty()) return cancel(ctx)
        RefreshWorker.runNow(ctx)
        schedule(ctx)
    }

    companion object {
        private const val INTERVAL_MS = 60_000L

        private fun pending(ctx: Context): PendingIntent =
            PendingIntent.getBroadcast(
                ctx, 0, Intent(ctx, LiveTicker::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        fun schedule(ctx: Context) {
            val am = ctx.getSystemService(AlarmManager::class.java) ?: return
            am.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + INTERVAL_MS, pending(ctx))
        }

        fun cancel(ctx: Context) {
            ctx.getSystemService(AlarmManager::class.java)?.cancel(pending(ctx))
        }
    }
}
