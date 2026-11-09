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
import org.json.JSONArray
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
    private const val DEVICE_IDENTITY = "device-identity"
    private const val PUSH = "push-registration"
    private const val PUSH_PENDING = "push-pending-deletions"

    /* `email`: for the Files app's root, which names the account; empty for a session saved before it was kept. */
    data class Session(val origin: String, val token: String, val userId: String, val email: String = "")
    data class Device(val bundle: RememberedDevice, val deviceKey: ByteArray)

    /*
     * This installation's device key (docs/devices-design.md): the seed the core made, the device
     * row it belongs to, the account, and the digest of the email it was made for (never the
     * address). Under the same Keystore master key as the session; not hardware Ed25519, which
     * needs API 33 against the app's minSdk 29. Kept apart from the remembered unlock: it outlives
     * a session ending and goes on sign-out.
     */
    data class DeviceIdentity(val userId: String, val emailHash: String, val deviceId: String, val seed: ByteArray)

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
        Session(it.getString("origin"), it.getString("token"), it.getString("userId"), it.optString("email"))
    }

    /*
     * The session is stored or dropped here, and the file pickers are told here: wherever it happens (the app, a
     * sign-in from a picker whose screen is then killed, a removal wipe), the HushOS root and its listing ask again.
     */
    fun writeSession(context: Context, session: Session) {
        write(context, SESSION, JSONObject().put("origin", session.origin).put("token", session.token).put("userId", session.userId).put("email", session.email))
        FilesRoots.changed(context)
    }

    fun clearSession(context: Context) {
        prefs(context).edit().remove(SESSION).apply()
        FilesRoots.changed(context)
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

    fun deviceIdentity(context: Context): DeviceIdentity? = read(context, DEVICE_IDENTITY)?.let {
        runCatching { DeviceIdentity(it.getString("userId"), it.getString("emailHash"), it.getString("deviceId"), base64urlDecode(it.getString("seed"))) }.getOrNull()
    }

    fun writeDeviceIdentity(context: Context, identity: DeviceIdentity) = write(
        context, DEVICE_IDENTITY,
        JSONObject().put("userId", identity.userId).put("emailHash", identity.emailHash).put("deviceId", identity.deviceId)
            .put("seed", base64urlEncode(identity.seed)),
    )

    fun clearDeviceIdentity(context: Context) {
        runCatching { prefs(context).edit().remove(DEVICE_IDENTITY).apply() }
    }

    /*
     * This phone's registration with the push relay (PushNotifications.Registration): the handle and the secret that
     * deletes it. Account data, beside the session under the same Keystore key; forgotten on every wipe.
     */
    fun pushRegistration(context: Context): JSONObject? = read(context, PUSH)

    /* Committed, not applied: a stop right after must still find the handle the server was about to be given. False when it wasn't written. */
    fun writePushRegistration(context: Context, registration: JSONObject): Boolean =
        runCatching { prefs(context).edit().putString(PUSH, registration.toString()).commit() }.getOrDefault(false)

    fun clearPushRegistration(context: Context) {
        runCatching { prefs(context).edit().remove(PUSH).commit() }
    }

    /*
     * Relay handles waiting to be deleted, with their secrets: not account data, so no wipe removes them; each goes once
     * its relay confirms (PushRegistrar.drain).
     */
    fun pushPending(context: Context): JSONArray? =
        runCatching { prefs(context).getString(PUSH_PENDING, null) }.getOrNull()?.let { runCatching { JSONArray(it) }.getOrNull() }

    fun writePushPending(context: Context, list: JSONArray?): Boolean = runCatching {
        prefs(context).edit().apply { if (list == null) remove(PUSH_PENDING) else putString(PUSH_PENDING, list.toString()) }.commit()
    }.getOrDefault(false)

    fun origin(context: Context): String? = read(context, CONFIG)?.optString("origin")?.takeIf { it.isNotEmpty() }

    fun writeOrigin(context: Context, origin: String) = write(context, CONFIG, JSONObject().put("origin", origin))
}
