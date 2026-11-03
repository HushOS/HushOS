package com.hushos.app.ui

import com.hushos.app.data.FamilyMemberRef
import com.hushos.app.data.Opened
import com.hushos.app.data.Vault
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

/*
 * Codex #281 3: Remove from family and Delete family folder belong to the session they began in. A sign-out or an account
 * switch (reset) drops both, so nothing is left asking, or stuck running, in the next session. Fails if either outlives it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyRemovalModelTest {
    private class Host : FamilyHost {
        override val currentVault: Vault? = null
        override val cacheDir: File = RuntimeEnvironment.getApplication().cacheDir
        override val state = MutableStateFlow(DriveState())
        override val familyScope = CoroutineScope(Dispatchers.Unconfined)
        override fun item(id: String): Opened? = null
        override fun updateState(change: (DriveState) -> DriveState) = state.update(change)
        override fun lostSession() {}
    }

    @Test
    fun aSessionResetDropsTheRemovalAndTheDeletion() {
        val model = FamiliesModel(Host())
        val group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
        model.askRemove(group, FamilyMemberRef("0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", "sam@example.org", "Sam Lindqvist"))
        model.askDeleteFolder(group, "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c", "Household")
        assertNotNull(model.removal)
        assertNotNull(model.deletingFolder)
        model.dueRunning[group] = true
        model.reset()
        assertEquals(null, model.removal)
        assertEquals(null, model.deletingFolder)
        assertEquals(emptyMap<String, Boolean>(), model.dueRunning.toMap())
    }
}
