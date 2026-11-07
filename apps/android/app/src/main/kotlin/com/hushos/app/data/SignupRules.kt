package com.hushos.app.data

/*
 * What sign-up checks before anything is sent, in the web's words (apps/web/src/lib/form.ts and
 * the register page). The password rule matters most: OPAQUE means the server never sees the
 * password, so this check is the only one there is. Lengths count UTF-16 units, as JavaScript's
 * `length` does (packages/crypto checkPassword), so a password the web refuses is refused here.
 */
object SignupRules {
    const val PASSWORD_MIN = 12
    const val PASSWORD_MAX = 128
    const val NAME_MAX = 100
    private const val EMAIL_MAX = 254
    private val EMAIL = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

    fun email(value: String): String? {
        val address = value.trim()
        return if (address.length > EMAIL_MAX || !EMAIL.matches(address)) "Enter an email address like name@example.com." else null
    }

    fun agreed(agreed: Boolean): String? = if (agreed) null else "Agree to the terms to carry on."

    fun name(value: String): String? {
        val name = value.trim()
        return when {
            name.isEmpty() -> "Enter your name."
            name.length > NAME_MAX -> "Use no more than $NAME_MAX characters."
            else -> null
        }
    }

    fun password(value: String): String? = when {
        value.length < PASSWORD_MIN -> "Use at least $PASSWORD_MIN characters."
        value.length > PASSWORD_MAX -> "Use no more than $PASSWORD_MAX characters."
        else -> null
    }

    fun confirm(password: String, confirm: String): String? = if (password != confirm) "The passwords don’t match." else null
}
