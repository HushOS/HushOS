package com.hushos.app.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.hushos.core.DeviceMemory
import com.hushos.core.RememberedDevice
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.rememberedDeviceFromJson
import com.hushos.core.rememberedDeviceToJson
import org.json.JSONObject

/*
 * What the app leaves for the documents provider: the session, the remembered
 * device that opens the account key, and the instance it talks to. Kept in an
 * encrypted preferences file under an Android Keystore master key; the
 * provider runs in the app's own process and reads the same file.
 */
object Shared {
    private const val FILE = "hushos-files"
    private const val SESSION = "session"
    private const val DEVICE = "device"
    private const val CONFIG = "config"

    data class Session(val origin: String, val token: String, val userId: String)
    data class Device(val bundle: RememberedDevice, val deviceKey: ByteArray)

    @Volatile private var opened: SharedPreferences? = null

    /*
     * Opened once per process. Each open does Keystore work, and the Keystore service
     * answers one caller at a time: opening it on every read made the main thread wait
     * behind a background upload's reads, long enough for Android to call the app frozen.
     */
    private fun prefs(context: Context): SharedPreferences = opened ?: synchronized(this) {
        opened ?: run {
            val app = context.applicationContext
            val key = MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            EncryptedSharedPreferences.create(
                app, FILE, key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            ).also { opened = it }
        }
    }

    /* A store that cannot be opened (a lost keyset, a wiped file) reads as signed out rather than failing every caller. */
    private fun read(context: Context, account: String): JSONObject? =
        runCatching { prefs(context).getString(account, null) }.getOrNull()?.let { runCatching { JSONObject(it) }.getOrNull() }

    private fun write(context: Context, account: String, value: JSONObject) {
        prefs(context).edit().putString(account, value.toString()).apply()
    }

    fun session(context: Context): Session? = read(context, SESSION)?.let {
        Session(it.getString("origin"), it.getString("token"), it.getString("userId"))
    }

    fun writeSession(context: Context, session: Session) =
        write(context, SESSION, JSONObject().put("origin", session.origin).put("token", session.token).put("userId", session.userId))

    fun clearSession(context: Context) {
        prefs(context).edit().remove(SESSION).apply()
    }

    fun device(context: Context): Device? = read(context, DEVICE)?.let {
        runCatching { Device(rememberedDeviceFromJson(it.getString("bundle")), base64urlDecode(it.getString("deviceKey"))) }.getOrNull()
    }

    fun writeDevice(context: Context, memory: DeviceMemory) = write(
        context, DEVICE,
        JSONObject().put("bundle", rememberedDeviceToJson(memory.bundle)).put("deviceKey", base64urlEncode(memory.deviceKey)),
    )

    fun clearDevice(context: Context) {
        prefs(context).edit().remove(DEVICE).apply()
    }

    fun origin(context: Context): String? = read(context, CONFIG)?.optString("origin")?.takeIf { it.isNotEmpty() }

    fun writeOrigin(context: Context, origin: String) = write(context, CONFIG, JSONObject().put("origin", origin))
}
