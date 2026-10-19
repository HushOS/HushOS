package com.hushos.app

import android.app.Activity
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.hushos.app.ui.DriveViewModel
import com.hushos.app.ui.HushOSTheme
import com.hushos.app.ui.PickerSignIn

/*
 * Sign-in for a file picker. The provider's sign-in affordance (AuthenticationRequiredException) starts this, for a
 * result, inside the picker's own task: once the account is open (sign-in, recovery and its new phrase included) it
 * answers RESULT_OK and finishes, so the picker comes back and lists HushOS. A launch from the home screen goes to
 * MainActivity as before; this never shows in Recents.
 */
class PickerSignInActivity : ComponentActivity() {
    private val model: DriveViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            HushOSTheme {
                PickerSignIn(model) {
                    setResult(Activity.RESULT_OK)
                    finish()
                }
            }
        }
    }
}
