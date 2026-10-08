package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

/*
 * Links that open the app. A share link carries its key after the #; losing it, or
 * opening another server's link against this one, or letting a crafted id through,
 * would each be noticed by someone. The same cases as iOS's AppLinksTests.
 */
class AppLinksTest {
    private val server = "https://hushos.com"
    private val token = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
    private val secret = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"
    private val folder = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
    private val file = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

    private fun parse(link: String, server: String = this.server) = AppLinks.parse(link, server)
    private fun opens(link: AppLink) = AppLinkResult.Open(link)
    private fun refused(reason: AppLinkRefusal) = AppLinkResult.Refused(reason)

    @Test
    fun aShareLinkKeepsItsKeyExactly() {
        assertEquals(opens(AppLink.Share("https://hushos.com/s/$token#$secret")), parse("https://hushos.com/s/$token#$secret"))
    }

    @Test
    fun aShareLinkWithoutItsKeyIsIncompleteNotOpened() {
        assertEquals(opens(AppLink.IncompleteShare), parse("https://hushos.com/s/$token"))
        assertEquals(opens(AppLink.IncompleteShare), parse("https://hushos.com/s/$token#"))
    }

    @Test
    fun aShareLinkWithACutOrForgedKeyIsRefused() {
        assertEquals(refused(AppLinkRefusal.Malformed), parse("https://hushos.com/s/$token#${secret.dropLast(5)}"))
        assertEquals(refused(AppLinkRefusal.Malformed), parse("https://hushos.com/s/short#$secret"))
        // 43 characters whose last one leaves non-zero spare bits: not 32 bytes the server could have made.
        assertEquals(refused(AppLinkRefusal.Malformed), parse("https://hushos.com/s/$token#${secret.dropLast(1)}l"))
    }

    @Test
    fun folderAndFileInTheViewer() {
        assertEquals(opens(AppLink.Files(null, null)), parse("https://hushos.com/app/drive"))
        assertEquals(opens(AppLink.Files(folder, null)), parse("https://hushos.com/app/drive?folder=$folder"))
        assertEquals(opens(AppLink.Files(folder, file)), parse("https://hushos.com/app/drive?folder=$folder&preview=$file"))
        assertEquals(opens(AppLink.Files(folder, null)), parse("https://hushos.com/app/drive?folder=${folder.uppercase()}"))
    }

    @Test
    fun homeSharedAndTrash() {
        assertEquals(opens(AppLink.Home), parse("https://hushos.com/app"))
        assertEquals(opens(AppLink.Shared(byMe = false)), parse("https://hushos.com/app/shared"))
        assertEquals(opens(AppLink.Shared(byMe = true)), parse("https://hushos.com/app/shared?view=by-me"))
        assertEquals(opens(AppLink.Trash), parse("https://hushos.com/app/trash"))
    }

    @Test
    fun billingAdminAndTheWebsiteStayOnTheWeb() {
        assertEquals(refused(AppLinkRefusal.WebOnly), parse("https://hushos.com/app/billing"))
        assertEquals(refused(AppLinkRefusal.WebOnly), parse("https://hushos.com/app/billing/plans"))
        assertEquals(refused(AppLinkRefusal.WebOnly), parse("https://hushos.com/app/admin/reports"))
        assertEquals(refused(AppLinkRefusal.WebOnly), parse("https://hushos.com/pricing"))
    }

    @Test
    fun anotherServersLinkIsNotOpenedHere() {
        assertEquals(refused(AppLinkRefusal.OtherServer("evil.example")), parse("https://evil.example/s/$token#$secret"))
        assertEquals(refused(AppLinkRefusal.OtherServer("hushos.com.evil.example")), parse("https://hushos.com.evil.example/app/drive"))
        // Same host, another port: another server.
        assertEquals(refused(AppLinkRefusal.OtherServer("hushos.com")), parse("https://hushos.com:8443/app"))
        assertEquals(refused(AppLinkRefusal.OtherServer("localhost")), parse("http://localhost:5174/app", server = "http://localhost:5173"))
    }

    @Test
    fun theCustomSchemeReachesTheSamePlacesOnTheSignedInServer() {
        assertEquals(opens(AppLink.Share("https://hushos.com/s/$token#$secret")), parse("hushos://s/$token#$secret"))
        assertEquals(opens(AppLink.Share("http://localhost:5173/s/$token#$secret")), parse("hushos://s/$token#$secret", server = "http://localhost:5173/"))
        assertEquals(opens(AppLink.Files(folder, null)), parse("hushos://app/drive?folder=$folder"))
        assertEquals(opens(AppLink.Shared(byMe = true)), parse("hushos://app/shared?view=by-me"))
        assertEquals(opens(AppLink.Home), parse("hushos://app"))
        assertEquals(opens(AppLink.Trash), parse("hushos://app/trash"))
        assertEquals(opens(AppLink.Node(file)), parse("hushos://node/$file"))
        assertEquals(refused(AppLinkRefusal.WebOnly), parse("hushos://app/billing"))
    }

    @Test
    fun idsThatAreNotIdsAreRefused() {
        assertEquals(refused(AppLinkRefusal.Malformed), parse("https://hushos.com/app/drive?folder=../../admin"))
        assertEquals(refused(AppLinkRefusal.Malformed), parse("https://hushos.com/app/drive?folder=$folder&preview=%3Cscript%3E"))
        assertEquals(refused(AppLinkRefusal.Malformed), parse("hushos://node/not-an-id"))
        assertEquals(refused(AppLinkRefusal.Malformed), parse("hushos://node/$file/extra"))
    }

    @Test
    fun otherSchemesAreNotLinks() {
        assertEquals(refused(AppLinkRefusal.Unsupported), parse("ftp://hushos.com/app"))
        assertEquals(refused(AppLinkRefusal.Unsupported), parse("javascript:alert(1)"))
    }

    @Test
    fun theRecoveryLinkOpensRecoveryWithItsToken() {
        assertEquals(opens(AppLink.Recover(token)), parse("https://hushos.com/recover/complete#verify=$token"))
        assertEquals(opens(AppLink.Recover(token)), parse("hushos://recover/complete#verify=$token"))
    }

    @Test
    fun aRecoveryLinkWithoutAWholeTokenOrFromAnotherServerIsNotOpened() {
        assertEquals(refused(AppLinkRefusal.Malformed), parse("https://hushos.com/recover/complete"))
        assertEquals(refused(AppLinkRefusal.Malformed), parse("https://hushos.com/recover/complete#verify=${token.dropLast(3)}"))
        assertEquals(refused(AppLinkRefusal.Malformed), parse("https://hushos.com/recover/complete#verify=%3Cscript%3E"))
        // The token rides in the fragment; one in the query (where a server would log it) is not accepted.
        assertEquals(refused(AppLinkRefusal.Malformed), parse("https://hushos.com/recover/complete?verify=$token"))
        assertEquals(refused(AppLinkRefusal.OtherServer("evil.example")), parse("https://evil.example/recover/complete#verify=$token"))
        // The email step itself stays on the web.
        assertEquals(refused(AppLinkRefusal.WebOnly), parse("https://hushos.com/recover"))
    }
}
