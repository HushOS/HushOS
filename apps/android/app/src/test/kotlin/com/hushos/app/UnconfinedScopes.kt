package com.hushos.app

import java.util.Collections
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/*
 * Scopes on Dispatchers.Unconfined for tests that run the app's code at once, cancelled after each
 * test. One left running can wake from a delay on kotlinx's JVM-wide DefaultExecutor and, if it
 * then blocks there, stall every delay in the test JVM: a later test that waits on one (the file
 * tools' watchdog did) hangs for no reason of its own.
 */
object UnconfinedScopes {
    private val scopes = Collections.synchronizedList(ArrayList<CoroutineScope>())

    fun create(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined).also { scopes.add(it) }

    fun cancelAll() {
        val all = synchronized(scopes) { scopes.toList().also { scopes.clear() } }
        for (scope in all) scope.cancel()
    }
}
