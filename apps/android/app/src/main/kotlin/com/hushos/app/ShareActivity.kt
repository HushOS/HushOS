package com.hushos.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.hushos.app.ui.HushOSTheme
import com.hushos.app.ui.SaveToHushOS
import com.hushos.app.ui.SaveViewModel

/* Save to HushOS in the share sheet: a sheet over the sending app, closed once the files are queued. */
class ShareActivity : ComponentActivity() {
    private val model: SaveViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        model.start(intent)
        setContent {
            HushOSTheme(ground = false) {
                SaveToHushOS(model, close = ::finish, openApp = {
                    startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    finish()
                })
            }
        }
    }
}
