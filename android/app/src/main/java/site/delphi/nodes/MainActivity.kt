package site.delphi.nodes

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast

/** The app's own screen: the background phone node (link wallet, start/stop, live status) and the widgets. */
class MainActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() { showNode(); ui.postDelayed(this, 2000) }
    }

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
        findViewById<Button>(R.id.node_link).setOnClickListener {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(NodeStore.linkUrl(this, NodeStore.approval(this)?.tokenId))))
        }
        findViewById<Button>(R.id.node_copy_link).setOnClickListener {
            val url = NodeStore.linkUrl(this, NodeStore.approval(this)?.tokenId)
            (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Delphi link", url))
            Toast.makeText(this, "Link copied. Paste it in your wallet app's browser, approve, then come back.", Toast.LENGTH_LONG).show()
        }
        findViewById<Button>(R.id.node_code_use).setOnClickListener {
            useCode(findViewById<EditText>(R.id.node_code).text.toString())
        }
        findViewById<Button>(R.id.node_toggle).setOnClickListener {
            if (NodeStore.running(this)) NodeService.stop(this)
            else {
                askNotificationPermission()
                NodeService.start(this)
            }
            ui.postDelayed({ showNode() }, 600)
        }
        handleLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    /** delphinodes://link?c=… from delphi.site/node/link */
    private fun handleLink(i: Intent?) {
        val data = i?.data ?: return
        if (data.scheme == "delphinodes" && data.host == "link") data.getQueryParameter("c")?.let { useCode(it) }
    }

    private fun useCode(code: String) {
        if (code.isBlank()) return
        val problem = NodeStore.importCode(this, code)
        Toast.makeText(this, problem ?: "Linked. Tap Start node.", Toast.LENGTH_LONG).show()
        if (problem == null) findViewById<EditText>(R.id.node_code).setText("")
        showNode()
    }

    override fun onResume() {
        super.onResume()
        showCards()
        ui.post(tick)
    }

    override fun onPause() {
        ui.removeCallbacks(tick)
        super.onPause()
    }

    private fun showNode() {
        val a = NodeStore.approval(this)
        val running = NodeStore.running(this)
        val now = System.currentTimeMillis() / 1000
        val linked = when {
            a == null -> "Not linked yet. Tap \"Link your wallet\", approve on delphi.site, then come back."
            a.expires <= now -> "Approval for card #${a.tokenId} expired. Link again."
            else -> "Linked: card #${a.tokenId} · wallet ${a.wallet.take(6)}…${a.wallet.takeLast(4)} · ${((a.expires - now) / 86400.0).let { if (it >= 1) "%.0f days".format(it) else "%.0f h".format(it * 24) }} left"
        }
        val st = NodeStore.status(this)
        findViewById<TextView>(R.id.node_status).text = if (st.isNotBlank()) "$linked\n\n$st" else linked
        findViewById<Button>(R.id.node_toggle).apply {
            setText(if (running) R.string.node_stop else R.string.node_start)
            isEnabled = running || (a != null && a.expires > now)
        }
        findViewById<Button>(R.id.node_link).setText(if (a == null) R.string.node_link else R.string.node_relink)
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    private fun showCards() {
        val cards = NodeWidgetProvider.widgetIds(this).map { StatusRepo.widgetCard(this, it) }.filter { it > 0 }.distinct().sorted()
        findViewById<TextView>(R.id.cards).text =
            if (cards.isEmpty()) getString(R.string.no_widgets)
            else cards.joinToString("\n") { c -> "Node #$c: ${StatusRepo.cached(this, c).label}" }
    }
}
