package com.hushos.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.hushos.app.ui.DriveViewModel
import com.hushos.app.ui.HushOSTheme
import com.hushos.app.ui.PickerSignIn

/*
 * Sign-in for a file picker. The provider's sign-in affordance (AuthenticationRequiredException) starts this, for a
 * result, inside the picker's own task: once the account is open it answers RESULT_OK and finishes, so the picker
 * comes back and lists HushOS. Recovery isn't done here: its emailed link opens the app's own screen, which shows the
 * new words; "Recover your account in the HushOS app" goes there, and coming back here finds the account open once
 * the words are confirmed as saved. A launch from the home screen goes to MainActivity as before.
 */
class PickerSignInActivity : ComponentActivity() {
    private val model: DriveViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Not the root of its task, so excludeFromRecents can't hide it: the picker's app would show this screen (and
        // the email typed into it) as its Recents thumbnail. Kept out of captures instead.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        setContent {
            HushOSTheme {
                PickerSignIn(
                    model,
                    recoverInApp = {
                        startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.RECOVER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    },
                    showWords = {
                        startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.SHOW_WORDS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    },
                ) {
                    setResult(Activity.RESULT_OK)
                    finish()
                }
            }
        }
    }

    /* Back from the app's own screen (a sign-in or a recovery finished there): the session is looked at again. */
    override fun onResume() {
        super.onResume()
        model.resumed()
    }
}
