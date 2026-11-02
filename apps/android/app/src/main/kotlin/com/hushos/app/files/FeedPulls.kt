package com.hushos.app.files

/*
 * The provider's pulls of the change feed, one at a time, off the binder thread. Each pull tells Files of the folders
 * it changed itself (Vault.sync). A listing asked for while a pull runs was answered from what the phone held at that
 * moment, which the running pull may not have reached: it is kept, another pull runs once this one ends, and then the
 * folder is told to ask again. Never dropped, as a busy flag alone would drop it.
 *
 * The folders are told only after the run has ended, so the listing they ask for starts a pull of its own rather than
 * being queued behind this one again (which would tell it again, and so on).
 */
class FeedPulls(
    private val execute: (Runnable) -> Unit,
    private val pull: () -> Unit,
    private val tell: (folders: Set<String>) -> Unit,
) {
    private val lock = Any()
    private var running = false
    private val waiting = LinkedHashSet<String>()

    /* A pull for a listing of `folder` (a document id), or for a poll (null). */
    fun request(folder: String?) {
        synchronized(lock) {
            if (running) {
                folder?.let { waiting.add(it) }
                return
            }
            running = true
        }
        execute(Runnable { run() })
    }

    private fun run() {
        val asked = LinkedHashSet<String>()
        while (true) {
            runCatching { pull() }
            val next = synchronized(lock) {
                if (waiting.isEmpty()) {
                    running = false
                    null
                } else waiting.toList().also { waiting.clear() }
            } ?: break
            asked.addAll(next)
        }
        if (asked.isNotEmpty()) runCatching { tell(asked) }
    }
}
