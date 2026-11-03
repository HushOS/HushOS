package com.hushos.app.ui

/*
 * The app shows one notice at a time (DriveState.notice). A notice that stays until it is read says something the person
 * can't find anywhere else (a share gone, a change to a family that won't be made), so one is never lost to the next:
 * until-read notices wait their turn behind a shown one, and one a passing notice covered comes back once that one has
 * gone. Passing notices (Undo, a short confirmation) replace each other as they always have.
 */
class NoticeQueue(private val show: (Notice?) -> Unit) {
    private var shown: Notice? = null
    private var shownUntilRead = false
    private val waiting = ArrayDeque<Notice>()

    /* A passing notice: shown now; an until-read one it covers goes back to the front of the line. */
    @Synchronized
    fun passing(notice: Notice) {
        if (shownUntilRead) shown?.let(waiting::addFirst)
        put(notice, untilRead = false)
    }

    /* A notice that stays until it is read: shown now, or after those before it are read. */
    @Synchronized
    fun untilRead(notice: Notice) {
        if (shownUntilRead) waiting.addLast(notice) else put(notice, untilRead = true)
    }

    /* The shown notice closed (OK, Undo, a swipe): the next waiting one, if any. */
    @Synchronized
    fun dismiss() = next()

    /* A passing notice's time ran out: the next waiting one, if that notice is still the one shown. */
    @Synchronized
    fun expire(id: Long) {
        if (shown?.id == id && !shownUntilRead) next()
    }

    /* Everything dropped (a sign-out): nothing shown, nothing waiting. */
    @Synchronized
    fun clear() {
        waiting.clear()
        put(null, untilRead = false)
    }

    private fun next() {
        val after = waiting.removeFirstOrNull()
        put(after, untilRead = after != null)
    }

    private fun put(notice: Notice?, untilRead: Boolean) {
        shown = notice
        shownUntilRead = untilRead
        show(notice)
    }
}
