package com.hushos.app.ui

import com.hushos.app.data.Opened

/*
 * What the folder lists do around a change of keys (a link turned off, sharing stopped),
 * kept apart from the view model so a test can hold it to it.
 */

/* The rows each loaded folder keeps showing, and the folders read again afterwards. */
internal data class Redraw(val shown: Map<String, List<Opened>>, val reload: Set<String>)

/*
 * After the keys rotate, every loaded folder keeps its rows (stale for a moment) and every
 * loaded folder is read again, wherever the item sat. Clearing them all and refreshing only
 * the item's parent left the folder on screen with nobody to reload it: an endless skeleton.
 */
internal fun afterAccessChange(folders: Map<String, List<Opened>>): Redraw = Redraw(folders, folders.keys)

/*
 * Whether the folder on screen has to be fetched: it isn't loaded, isn't loading, and hasn't
 * failed (a failed folder shows Try again rather than fetching in a loop).
 */
internal fun needsLoad(folderId: String?, folders: Map<String, *>, loading: Set<String>, failed: Set<String>): Boolean =
    folderId != null && !folders.containsKey(folderId) && folderId !in loading && folderId !in failed
