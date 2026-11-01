package com.hushos.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.hushos.app.data.Opened
import com.hushos.app.data.Unverified
import com.hushos.app.data.checkTarget
import com.hushos.app.data.firstNameOf
import com.hushos.app.data.explanation
import com.hushos.core.Integrity
import com.hushos.tokens.AlpineSpace

/*
 * The Unverified mark: a small warning-tinted label beside a row's line, under a sheet's name and in Info, for a
 * record whose writer can't be confirmed (docs/integrity-design.md, "Reading"; docs/optional-verification.md 6.12).
 * Verified records show nothing, and neither do a first-seen writer's (Info says "Not verified"). When whom this
 * person trusts couldn't load, every record shows the same mark as Couldn't check, never nothing. Tapping it says
 * which case it is in calm words; the way out is Check who wrote this (or Check it's Maya for someone in Contacts) or
 * Try again. It warns; the item still opens.
 */
@Composable
fun UnverifiedMark(model: DriveViewModel, state: DriveState, item: Opened) {
    val unverified = model.unverified(item, state) ?: return
    var open by remember { mutableStateOf(false) }
    val alpine = Alpine.colors
    val label = if (unverified.integrity == Integrity.UNCHECKED) "Couldn’t check" else "Unverified"
    Text(
        label, style = MaterialTheme.typography.labelSmall, color = alpine.warning, maxLines = 1,
        modifier = Modifier
            .background(alpine.warningSoft, RoundedCornerShape(4.dp))
            .clickable(role = Role.Button, onClickLabel = "Why") { open = true }
            .semantics { contentDescription = "$label. Why" }
            .padding(horizontal = 6.dp, vertical = 1.dp),
    )
    if (open) UnverifiedSheet(model, item, unverified) { open = false }
}

@Composable
fun UnverifiedSheet(model: DriveViewModel, item: Opened, unverified: Unverified, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    val target = unverified.checkTarget
    val unchecked = unverified.integrity == Integrity.UNCHECKED
    Sheet(onDismissRequest = dismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
            Text(if (unchecked) "Couldn’t check" else "Unverified", style = MaterialTheme.typography.titleLarge)
            Text(item.name, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1)
            Text(unverified.explanation(), style = MaterialTheme.typography.bodyLarge, color = alpine.ink)
            // The check is the app's to show (Main), not this sheet's: adding the writer clears the mark, and this sheet with it.
            if (target != null) Button(onClick = {
                model.contactStep = if (target.pinned) ContactStep.Check(target.email, target.name) else ContactStep.Add(writer = target.id)
                dismiss()
            }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(if (target.pinned) "Check it’s ${firstNameOf(target.name.ifEmpty { target.email })}" else "Check who wrote this") }
            if (unchecked) Button(onClick = { model.retryTrust(); dismiss() }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Try again") }
        }
    }
}
