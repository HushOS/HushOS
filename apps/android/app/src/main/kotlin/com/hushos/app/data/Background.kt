package com.hushos.app.data

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat

/*
 * What lets transfers carry on once HushOS is in the background: notifications (the
 * progress notification a long job runs under), battery optimisation (which can pause
 * the job), and Data Saver (which can stop it using data). Read fresh each time; the
 * person changes them in Settings.
 */
data class BackgroundAccess(val notifications: Boolean, val battery: Boolean, val data: Boolean) {
    val allSet get() = notifications && battery && data
}

object Background {
    /* "Not now" waits this long before a transfer may ask again. */
    const val QUIET_FOR = 7 * 24 * 60 * 60_000L

    fun read(context: Context): BackgroundAccess {
        val power = context.getSystemService(PowerManager::class.java)
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        return BackgroundAccess(
            notifications = NotificationManagerCompat.from(context).areNotificationsEnabled(),
            battery = power?.isIgnoringBatteryOptimizations(context.packageName) ?: true,
            data = connectivity?.restrictBackgroundStatus != ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED,
        )
    }

    /* Whether a transfer that just started asks: something is off, and "Not now" was never said or a week ago. */
    fun shouldAsk(access: BackgroundAccess, notNowAt: Long?, now: Long): Boolean =
        !access.allSet && (notNowAt == null || now - notNowAt >= QUIET_FOR)

    /* HushOS's notification settings, for when the system prompt can't be shown again. */
    fun notificationSettings(context: Context) = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)

    /* The list of apps and their battery optimisation; the direct prompt is left alone (Play restricts it). */
    fun batterySettings() = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)

    /* Data Saver's exception for HushOS. */
    fun dataSettings(context: Context) = Intent(Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS, Uri.parse("package:${context.packageName}"))

    /* Whether the system prompt for notifications exists on this Android (13 and later). */
    val asksForNotifications get() = Build.VERSION.SDK_INT >= 33
}
