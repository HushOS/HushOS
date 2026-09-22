package com.hushos.files

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/*
 * What the app leaves for the documents provider: the session, the remembered
 * device that opens the account key, and the instance it talks to. Kept in an
 * encrypted preferences file under an Android Keystore master key; the
 * provider runs in the app's own process and reads the same file.
 */
object Shared {
    private const val FILE = "hushos-files"
    const val SESSION = "session"
    const val DEVICE = "device"
    const val CONFIG = "config"

    private fun prefs(context: Context): SharedPreferences {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        return EncryptedSharedPreferences.create(
            context, FILE, key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun read(context: Context, account: String): JSONObject? =
        prefs(context).getString(account, null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    fun write(context: Context, account: String, value: JSONObject) {
        prefs(context).edit().putString(account, value.toString()).apply()
    }

    fun delete(context: Context, account: String) {
        prefs(context).edit().remove(account).apply()
    }
}
