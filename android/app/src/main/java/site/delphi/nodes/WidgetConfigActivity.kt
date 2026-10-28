package site.delphi.nodes

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast

/** Shown when a Delphi widget is added: which card number should it show? */
class WidgetConfigActivity : Activity() {
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED) // backing out cancels adding the widget
        widgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        setContentView(R.layout.activity_config)
        val input = findViewById<EditText>(R.id.card_input)
        findViewById<Button>(R.id.save).setOnClickListener {
            val card = input.text.toString().trim().toIntOrNull()
            if (card == null || card !in 1..2500) {
                Toast.makeText(this, getString(R.string.bad_card), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            StatusRepo.setWidgetCard(this, widgetId, card)
            NodeWidgetProvider.render(this, AppWidgetManager.getInstance(this), widgetId)
            RefreshWorker.schedule(this)
            RefreshWorker.runNow(this)
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
            finish()
        }
    }
}
