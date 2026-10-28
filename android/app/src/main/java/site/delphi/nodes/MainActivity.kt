package site.delphi.nodes

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.TextView

/** The app's own screen: how to add widgets, which cards are on the home screen, and a manual refresh. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        findViewById<Button>(R.id.refresh).setOnClickListener {
            RefreshWorker.runNow(this)
            findViewById<TextView>(R.id.cards).postDelayed({ showCards() }, 4000)
        }
        findViewById<Button>(R.id.open_site).setOnClickListener {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${StatusRepo.SITE}/node")))
        }
    }

    override fun onResume() {
        super.onResume()
        showCards()
    }

    private fun showCards() {
        val cards = NodeWidgetProvider.widgetIds(this).map { StatusRepo.widgetCard(this, it) }.filter { it > 0 }.distinct().sorted()
        findViewById<TextView>(R.id.cards).text =
            if (cards.isEmpty()) getString(R.string.no_widgets)
            else cards.joinToString("\n") { c -> "Node #$c: ${StatusRepo.cached(this, c).label}" }
    }
}
