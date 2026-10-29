package site.delphi.nodes

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

/** Home-screen widget: one card's PFP oracle (its face and role swag; the plain silhouette until that's downloaded)
 *  in its live status color. Tap opens the card on delphi.site. */
class NodeWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        ids.forEach { render(ctx, mgr, it) }
        RefreshWorker.schedule(ctx)
        RefreshWorker.runNow(ctx)
        LiveTicker.schedule(ctx)
    }

    override fun onDeleted(ctx: Context, ids: IntArray) {
        ids.forEach { StatusRepo.removeWidget(ctx, it) }
    }

    override fun onEnabled(ctx: Context) {
        RefreshWorker.schedule(ctx)
        LiveTicker.schedule(ctx)
    }

    override fun onDisabled(ctx: Context) {
        RefreshWorker.cancel(ctx)
        LiveTicker.cancel(ctx)
    }

    companion object {
        fun widgetIds(ctx: Context): IntArray =
            AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, NodeWidgetProvider::class.java))

        fun renderAll(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx)
            widgetIds(ctx).forEach { render(ctx, mgr, it) }
        }

        fun render(ctx: Context, mgr: AppWidgetManager, widgetId: Int) {
            val card = StatusRepo.widgetCard(ctx, widgetId)
            val views = RemoteViews(ctx.packageName, R.layout.widget_node)
            if (card <= 0) {
                views.setTextViewText(R.id.card_number, "Delphi")
                views.setTextViewText(R.id.status_label, "Tap to set up")
                views.setInt(R.id.silhouette, "setColorFilter", 0xFF6B6250.toInt())
                views.setViewVisibility(R.id.silhouette, android.view.View.VISIBLE)
                views.setViewVisibility(R.id.pfp, android.view.View.GONE)
            } else {
                val s = StatusRepo.cached(ctx, card)
                views.setTextViewText(R.id.card_number, "#$card")
                views.setTextViewText(R.id.status_label, s.label)
                views.setTextColor(R.id.status_label, s.color)
                val pfp = PfpCache.bitmap(ctx, card, s.color)
                if (pfp != null) {
                    views.setImageViewBitmap(R.id.pfp, pfp)
                    views.setContentDescription(R.id.pfp, "Node $card: ${s.label}")
                } else {
                    views.setInt(R.id.silhouette, "setColorFilter", s.color)
                    views.setContentDescription(R.id.silhouette, "Node $card: ${s.label}")
                }
                views.setViewVisibility(R.id.pfp, if (pfp != null) android.view.View.VISIBLE else android.view.View.GONE)
                views.setViewVisibility(R.id.silhouette, if (pfp != null) android.view.View.GONE else android.view.View.VISIBLE)
                val line = if (s.state == "unknown") "" else s.statsLine
                views.setTextViewText(R.id.stats_line, line)
                views.setViewVisibility(R.id.stats_line, if (line.isEmpty()) android.view.View.GONE else android.view.View.VISIBLE)
                val open = Intent(Intent.ACTION_VIEW, Uri.parse("${StatusRepo.SITE}/card/$card"))
                views.setOnClickPendingIntent(
                    R.id.widget_root,
                    PendingIntent.getActivity(ctx, widgetId, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
                )
            }
            mgr.updateAppWidget(widgetId, views)
        }
    }
}
