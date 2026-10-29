package site.delphi.nodes

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** Fetches the status of every card shown in a widget, then redraws the widgets. Runs about every minute while the
 *  phone is awake (LiveTicker), every 15 minutes as a backstop, and right away when a widget is added or "Refresh"
 *  is tapped. */
class RefreshWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        val cards = NodeWidgetProvider.widgetIds(ctx).map { StatusRepo.widgetCard(ctx, it) }.filter { it > 0 }.toSet()
        var failed = false
        for (card in cards) {
            try {
                StatusRepo.save(ctx, StatusRepo.fetch(card))
            } catch (e: Exception) {
                failed = true
            }
            PfpCache.prefetch(ctx, card) // the card's PFP in every status color (no-op once cached for the day)
        }
        NodeWidgetProvider.renderAll(ctx)
        if (cards.isNotEmpty()) LiveTicker.schedule(ctx) // keeps the 1-min chain alive, and restarts it after reboot/update
        if (failed && runAttemptCount < 3) Result.retry() else Result.success()
    }

    companion object {
        private const val PERIODIC = "delphi-node-widgets"
        private const val NOW = "delphi-node-widgets-now"
        private val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES).setConstraints(net).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun runNow(ctx: Context) {
            val req = OneTimeWorkRequestBuilder<RefreshWorker>().setConstraints(net).build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, req)
        }

        fun cancel(ctx: Context) {
            WorkManager.getInstance(ctx).cancelUniqueWork(PERIODIC)
        }
    }
}
