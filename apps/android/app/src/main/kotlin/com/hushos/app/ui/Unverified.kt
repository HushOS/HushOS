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
import com.hushos.app.data.explanation
import com.hushos.core.Integrity
import com.hushos.tokens.AlpineSpace

/*
 * The Unverified mark: a small warning-tinted label beside a row's line, under a sheet's name and in Info, for a
 * record whose writer's signature this account can't tie to anyone it checked (docs/integrity-design.md, "Reading").
 * Verified records show nothing. Tapping it says which case it is and who the server says wrote it; for someone not
 * checked yet, the way out is checking their words. It warns; the item still opens.
 */
@Composable
fun UnverifiedMark(model: DriveViewModel, state: DriveState, item: Opened) {
    val unverified = model.unverified(item, state) ?: return
    var open by remember { mutableStateOf(false) }
    val alpine = Alpine.colors
    Text(
        "Unverified", style = MaterialTheme.typography.labelSmall, color = alpine.warning, maxLines = 1,
        modifier = Modifier
            .background(alpine.warningSoft, RoundedCornerShape(4.dp))
            .clickable(role = Role.Button, onClickLabel = "Why it’s unverified") { open = true }
            .semantics { contentDescription = "Unverified. Why" }
            .padding(horizontal = 6.dp, vertical = 1.dp),
    )
    if (open) UnverifiedSheet(model, item, unverified) { open = false }
}

@Composable
fun UnverifiedSheet(model: DriveViewModel, item: Opened, unverified: Unverified, dismiss: () -> Unit) {
    val alpine = Alpine.colors
    var checking by remember { mutableStateOf(false) }
    val signer = unverified.signer
    if (checking && signer != null) {
        CheckThemSheet(model, signer.email, null, dismiss = { checking = false }) { pin ->
            checking = false
            model.notify("${pin.name.ifEmpty { pin.email }} checked and added")
            dismiss()
        }
        return
    }
    Sheet(onDismissRequest = dismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S3)) {
            Text("Unverified", style = MaterialTheme.typography.titleLarge)
            Text(item.name, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, maxLines = 1)
            Text(unverified.explanation(), style = MaterialTheme.typography.bodyLarge,
                color = if (unverified.integrity == Integrity.BAD_SIGNATURE) alpine.danger else alpine.ink)
            if (unverified.integrity == Integrity.UNKNOWN_SIGNER && signer != null && signer.email.isNotEmpty())
                Button(onClick = { checking = true }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Check their words") }
        }
    }
}
