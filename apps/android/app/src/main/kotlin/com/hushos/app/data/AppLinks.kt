package com.hushos.app.data

import java.net.URI

/*
 * Where a link opens in the app: the paths the web declares for the apps in
 * /.well-known/assetlinks.json (apps/web/src/lib/app-links.server.ts), plus the
 * hushos:// scheme with the same paths and hushos://node/<id>. One pure function,
 * the same cases and names as iOS's AppLinks, so the rules that keep a link's
 * secret and refuse another server's links are tested once and used everywhere.
 */
sealed interface AppLink {
    data object Home : AppLink
    /* A folder (null for the top), and a file in it to open. */
    data class Files(val folder: String?, val preview: String?) : AppLink
    data class Shared(val byMe: Boolean) : AppLink
    data object Trash : AppLink
    /* A share link, rebuilt on the signed-in server with its key: what LinkVault opens. */
    data class Share(val url: String) : AppLink
    /* A share link whose key (after the #) was cut off: "This link is incomplete". */
    data object IncompleteShare : AppLink
    /* hushos://node/<id>: a file or folder, whichever it turns out to be. */
    data class Node(val id: String) : AppLink
    /* The emailed recovery link, /recover/complete#verify=<token>: account recovery picks up in the app. */
    data class Recover(val verify: String) : AppLink
}

sealed interface AppLinkRefusal {
    /* A link to another HushOS server than the one signed in to. */
    data class OtherServer(val host: String) : AppLinkRefusal
    /* A page that stays on the web (billing, the operator console, the website). */
    data object WebOnly : AppLinkRefusal
    /* An id or a share link that isn't well formed. */
    data object Malformed : AppLinkRefusal
    /* Not a HushOS link at all. */
    data object Unsupported : AppLinkRefusal
}

/* What a link resolves to: a place in the app, or why it isn't opened here. */
sealed interface AppLinkResult {
    data class Open(val link: AppLink) : AppLinkResult
    data class Refused(val reason: AppLinkRefusal) : AppLinkResult
}

object AppLinks {
    private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    private val BASE64URL = Regex("^[A-Za-z0-9_-]{43}$")
    /* An email link's one-time token (packages/auth TOKEN_PATTERN). */
    private val TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
    /* The last of 43 characters carries 4 bits of a 32-byte value and 2 zero bits: anything else isn't one. */
    private const val LAST = "AEIMQUYcgkosw048"

    private fun open(link: AppLink) = AppLinkResult.Open(link)
    private fun refuse(reason: AppLinkRefusal) = AppLinkResult.Refused(reason)

    /*
     * `server` is the signed-in origin (e.g. https://hushos.com). https links must name
     * its host and port; hushos:// links carry no host and always mean the signed-in server.
     */
    fun parse(link: String, server: String): AppLinkResult {
        val uri = runCatching { URI(link) }.getOrNull() ?: return refuse(AppLinkRefusal.Unsupported)
        val origin = runCatching { URI(server) }.getOrNull() ?: return refuse(AppLinkRefusal.Unsupported)
        val serverHost = origin.host?.lowercase() ?: return refuse(AppLinkRefusal.Unsupported)
        val scheme = uri.scheme?.lowercase() ?: return refuse(AppLinkRefusal.Unsupported)
        if (uri.isOpaque) return refuse(AppLinkRefusal.Unsupported)
        val segments = { path: String? -> path.orEmpty().split('/').filter { it.isNotEmpty() } }
        val path: List<String> = when (scheme) {
            // hushos://app/drive?folder=… reads as host "app" and path "/drive".
            "hushos" -> (listOfNotNull(uri.host ?: uri.rawAuthority) + segments(uri.rawPath)).filter { it.isNotEmpty() }
            "https", "http" -> {
                val host = uri.host?.lowercase().orEmpty()
                if (host != serverHost || port(uri) != port(origin)) return refuse(AppLinkRefusal.OtherServer(host))
                segments(uri.rawPath)
            }
            else -> return refuse(AppLinkRefusal.Unsupported)
        }
        val query = uri.rawQuery.orEmpty().split('&').mapNotNull { pair ->
            val at = pair.indexOf('=')
            if (at <= 0) null else pair.substring(0, at) to java.net.URLDecoder.decode(pair.substring(at + 1), "UTF-8")
        }.distinctBy { it.first }.toMap()

        return when (path.firstOrNull()) {
            "node" -> if (path.size == 2 && isId(path[1])) open(AppLink.Node(path[1].lowercase())) else refuse(AppLinkRefusal.Malformed)
            "s" -> {
                if (path.size != 2) return refuse(AppLinkRefusal.Malformed)
                val token = path[1]
                // The key never reaches a server; without it the link opens nothing.
                val secret = uri.rawFragment
                if (secret.isNullOrEmpty()) return if (isKey(token)) open(AppLink.IncompleteShare) else refuse(AppLinkRefusal.Malformed)
                if (!isKey(token) || !isKey(secret)) return refuse(AppLinkRefusal.Malformed)
                open(AppLink.Share("${server.trimEnd('/')}/s/$token#$secret"))
            }
            "recover" -> {
                if (path.size != 2 || path[1] != "complete") return refuse(AppLinkRefusal.WebOnly)
                // The token rides in the fragment, as the web reads it, so it never reaches a server log.
                val verify = uri.rawFragment.orEmpty().split('&').firstOrNull { it.startsWith("verify=") }?.removePrefix("verify=")
                if (verify == null || !TOKEN.matches(verify)) refuse(AppLinkRefusal.Malformed) else open(AppLink.Recover(verify))
            }
            "app" -> {
                val page = path.drop(1)
                when (page.firstOrNull()) {
                    null -> open(AppLink.Home)
                    "drive" -> {
                        if (page.size != 1) return refuse(AppLinkRefusal.WebOnly)
                        val folder = query["folder"]
                        val preview = query["preview"]
                        if (folder != null && !isId(folder)) return refuse(AppLinkRefusal.Malformed)
                        if (preview != null && !isId(preview)) return refuse(AppLinkRefusal.Malformed)
                        open(AppLink.Files(folder?.lowercase(), preview?.lowercase()))
                    }
                    "shared" -> if (page.size != 1) refuse(AppLinkRefusal.WebOnly) else open(AppLink.Shared(byMe = query["view"] == "by-me"))
                    "trash" -> if (page.size != 1) refuse(AppLinkRefusal.WebOnly) else open(AppLink.Trash)
                    // /app/admin, /app/billing and every other page stay on the web.
                    else -> refuse(AppLinkRefusal.WebOnly)
                }
            }
            else -> refuse(AppLinkRefusal.WebOnly)
        }
    }

    private fun port(uri: URI): Int? = when {
        uri.port != -1 -> uri.port
        uri.scheme.equals("https", ignoreCase = true) -> 443
        uri.scheme.equals("http", ignoreCase = true) -> 80
        else -> null
    }

    /* Node ids are UUIDs; anything else (a path, a query, a script) is refused before it reaches a lookup. */
    fun isId(value: String) = UUID.matches(value)

    /* A link token or secret is 32 bytes of base64url without padding: 43 characters, the last one canonical. */
    fun isKey(value: String) = BASE64URL.matches(value) && value.last() in LAST
}
