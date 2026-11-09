package com.hushos.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.hushos.app.data.PushNotifications
import com.hushos.app.data.PushTokens
import com.hushos.app.data.Shared
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * Account → Notifications, the web's AccountNotifications: whether this phone gets them, and the two kinds a person can
 * turn off. Security notices always come. Hidden on a server with notifications off, one whose pushes can't reach this
 * app (no relay, or not HushOS's), and in a build without Firebase. Android asks for POST_NOTIFICATIONS only from the
 * switch, never on its own.
 */
@Composable
fun NotificationsSection() {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var toggles by remember { mutableStateOf<PushNotifications.Toggles?>(null) }
    var relay by remember { mutableStateOf<String?>(null) }
    var phone by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    // Bumped whenever HushOS comes back (from Settings or anywhere), so the switch follows what Android allows now.
    var resumed by remember { mutableIntStateOf(0) }
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) resumed++
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    fun phoneOn(): Boolean {
        val session = Shared.session(context) ?: return false
        return PushNotifications.registration(context)?.belongsTo(session) == true && PushTokens.allowed(context)
    }

    LaunchedEffect(resumed) {
        if (!PushTokens.configured) return@LaunchedEffect
        val read = withContext(Dispatchers.IO) { runCatching { PushNotifications.serverState(context) to phoneOn() } }
        // A read that fails keeps what was shown; a first one leaves the section out, as on a server without them.
        read.getOrNull()?.let { (state, on) ->
            toggles = state?.toggles
            relay = state?.relay
            phone = on
        }
    }

    fun turnOn(target: String) = scope.launch {
        val outcome = withContext(Dispatchers.IO) {
            runCatching {
                if (!PushTokens.allowed(context)) throw PushNotifications.Refused("Notifications are off for HushOS. Turn them on in Settings, then try again.")
                PushNotifications.register(context, PushTokens.token(context), target)
            }
        }
        problem = outcome.exceptionOrNull()?.let(::words)
        phone = withContext(Dispatchers.IO) { phoneOn() }
        busy = false
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val target = relay
        if (granted && target != null) turnOn(target)
        else {
            problem = "Notifications are off for HushOS. Turn them on in Settings, then try again."
            phone = false
            busy = false
        }
    }

    fun setPhone(on: Boolean) {
        val target = relay ?: return
        if (busy) return
        busy = true
        problem = null
        phone = on
        if (!on) {
            scope.launch {
                val outcome = withContext(Dispatchers.IO) { runCatching { PushNotifications.turnOff(context) } }
                problem = outcome.exceptionOrNull()?.let(::words)
                phone = withContext(Dispatchers.IO) { phoneOn() }
                busy = false
            }
            return
        }
        // Android 13 and later ask here, from the switch, and only if not yet allowed.
        if (Build.VERSION.SDK_INT >= 33 && !PushTokens.allowed(context)) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else turnOn(target)
    }

    fun setToggle(next: PushNotifications.Toggles) {
        val before = toggles ?: return
        toggles = next
        problem = null
        scope.launch {
            val saved = withContext(Dispatchers.IO) { runCatching { PushNotifications.save(context, next) } }
            saved.onSuccess { toggles = it }.onFailure {
                toggles = before
                problem = "Your notification settings weren’t saved. Please try again."
            }
        }
    }

    val shown = toggles ?: return
    if (relay == null) return
    Subheader("Notifications")
    SwitchRow("On this phone", "Notices here while HushOS is closed", phone, enabled = !busy) { setPhone(it) }
    SwitchRow("Shared with you", "When someone shares something with you", shown.shared) { setToggle(shown.copy(shared = it)) }
    SwitchRow("Families", "Invitations, and people waiting to join your family", shown.family) { setToggle(shown.copy(family = it)) }
    Text(
        "New sign-ins and removed devices always come. Pushes never say what happened; this phone reads that from HushOS.",
        style = MaterialTheme.typography.bodySmall, color = alpine.inkMuted,
        modifier = Modifier.padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2),
    )
    problem?.let {
        Text(it, style = MaterialTheme.typography.bodySmall, color = alpine.danger, modifier = Modifier.padding(horizontal = AlpineSpace.S4))
    }
}

private fun words(error: Throwable): String = when (error) {
    is PushNotifications.Refused -> error.message ?: "Please try again."
    is com.hushos.app.data.AuthUnreachable -> com.hushos.app.data.Auth.UNREACHABLE
    is com.hushos.app.data.NotAuthenticated -> "Your session ended. Sign in again."
    else -> "Please try again."
}

@Composable
private fun SwitchRow(title: String, detail: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val alpine = Alpine.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange)
            .padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = AlpineSpace.S4)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = alpine.ink)
            Text(detail, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted)
        }
        // The row takes the tap; the switch only shows the state.
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}
