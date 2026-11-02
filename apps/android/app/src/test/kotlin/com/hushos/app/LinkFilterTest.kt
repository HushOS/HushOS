package com.hushos.app

import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.PatternMatcher
import com.hushos.app.data.AppLink
import com.hushos.app.data.AppLinkResult
import com.hushos.app.data.AppLinks
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.w3c.dom.Element

/*
 * What the manifest hands the app: a link the server's verified filter doesn't list opens in the
 * browser however well AppLinks reads it, so the mailed invitation would dead-end on the web. The
 * filter is read from the manifest itself with a release build's placeholders (https, hushos.com,
 * build.gradle.kts) and matched by Android's own IntentFilter.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LinkFilterTest {
    private val token = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
    private val android = "http://schemas.android.com/apk/res/android"

    /* LinkActivity's verified filter as a release build merges it, and its autoVerify. */
    private fun verifiedFilter(): Pair<IntentFilter, String> {
        val manifest = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(File("src/main/AndroidManifest.xml"))
        val activities = manifest.getElementsByTagName("activity")
        val link = (0 until activities.length).map { activities.item(it) as Element }
            .single { it.getAttributeNS(android, "name") == ".LinkActivity" }
        val filters = link.getElementsByTagName("intent-filter")
        val verified = (0 until filters.length).map { filters.item(it) as Element }.single { it.hasAttributeNS(android, "autoVerify") }
        val release = mapOf("\${appLinkScheme}" to "https", "\${appLinkHost}" to "hushos.com", "\${appLinkVerify}" to "true")
        fun value(element: Element, name: String) = element.getAttributeNS(android, name).let { release[it] ?: it }
        fun each(tag: String, block: (Element) -> Unit) =
            verified.getElementsByTagName(tag).let { list -> (0 until list.length).forEach { block(list.item(it) as Element) } }
        val filter = IntentFilter()
        each("action") { filter.addAction(value(it, "name")) }
        each("category") { filter.addCategory(value(it, "name")) }
        each("data") { data ->
            value(data, "scheme").takeIf { it.isNotEmpty() }?.let(filter::addDataScheme)
            value(data, "host").takeIf { it.isNotEmpty() }?.let { filter.addDataAuthority(it, null) }
            value(data, "path").takeIf { it.isNotEmpty() }?.let { filter.addDataPath(it, PatternMatcher.PATTERN_LITERAL) }
            value(data, "pathPrefix").takeIf { it.isNotEmpty() }?.let { filter.addDataPath(it, PatternMatcher.PATTERN_PREFIX) }
        }
        return filter to value(verified, "autoVerify")
    }

    private fun opensInApp(link: String): Boolean {
        val uri = Uri.parse(link)
        val categories = setOf(Intent.CATEGORY_BROWSABLE, Intent.CATEGORY_DEFAULT)
        return verifiedFilter().first.match(Intent.ACTION_VIEW, null, uri.scheme, uri, categories, "LinkFilterTest") >= 0
    }

    @Test
    fun theMailedInvitationOpensTheInvitationSheet() {
        val link = "https://hushos.com/join#invite=$token"
        assertEquals("true", verifiedFilter().second)
        assertTrue(opensInApp(link))
        // And LinkActivity's hand-off reads it as the invitation, token intact.
        assertEquals(AppLinkResult.Open(AppLink.Join(token)), AppLinks.parse(link, "https://hushos.com"))
    }

    @Test
    fun whatTheAppCantDoStaysInTheBrowser() {
        assertTrue(opensInApp("https://hushos.com/s/$token"))
        for (path in listOf("/join/other", "/joinus", "/app/billing", "/app/admin", "/pricing", "/"))
            assertEquals(path, false, opensInApp("https://hushos.com$path"))
        assertEquals(false, opensInApp("https://evil.example/join#invite=$token"))
        assertEquals(false, opensInApp("http://hushos.com/join#invite=$token"))
    }
}
