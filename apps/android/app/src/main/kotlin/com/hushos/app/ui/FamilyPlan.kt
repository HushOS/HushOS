package com.hushos.app.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.hushos.app.data.FamilyPlan
import com.hushos.app.data.GroupDetail
import com.hushos.tokens.AlpineSpace

/*
 * The family's plan on its page, read only (docs/groups-mobile-plan.md, iOS 7 and Android 7): which plan, the pool, and
 * who pays, in the web's words, then one line that billing is managed on the web. No price, no "upgrade", no link and no
 * button: Google Play's payments policy, which the owner applies to the sideloaded build too.
 */

/*
 * The section's first line (which plan: the section is already called Plan, as the web's glance has it), its rows,
 * label and figure, then its one line. Pure, so what the phone says is tested without a screen.
 */
data class FamilyPlanLines(val plan: String, val rows: List<Pair<String, String>>, val note: String) {
    companion object {
        const val MANAGED_ON_THE_WEB = "Billing is managed on the web."

        fun of(plan: FamilyPlan, members: List<GroupDetail.Member>?): FamilyPlanLines {
            val quota = plan.quotaBytes?.takeIf { it > 0 }
            val which = when {
                plan.name != null -> listOfNotNull(plan.name, quota?.let(::formatQuota)).joinToString(" · ")
                plan.lapsed != null -> plan.lapsed.line
                else -> "No family plan right now"
            }
            val rows = ArrayList<Pair<String, String>>()
            if (quota != null) rows.add("Used" to "${formatSpace(plan.usedBytes ?: 0L)} of ${formatQuota(quota)}")
            // Who pays, only as the server named them: the web's "Paid by" (personLine), never guessed from roles.
            when (val payer = plan.payer) {
                FamilyPlan.Payer.You -> rows.add("Paid by" to "You")
                is FamilyPlan.Payer.Member -> members?.firstOrNull { it.userId.equals(payer.userId, ignoreCase = true) }
                    ?.let { rows.add("Paid by" to if (it.email != null) "${it.name} (${it.email})" else it.name) }
                null -> {}
            }
            return FamilyPlanLines(which, rows, MANAGED_ON_THE_WEB)
        }
    }
}

/* The plan, under the members: nothing at all while billing is off on the server or the plan didn't load. */
@Composable
fun FamilyPlanSection(model: DriveViewModel, groupId: String) {
    val families = model.families
    var plan by remember(groupId) { mutableStateOf<FamilyPlan?>(null) }
    LaunchedEffect(groupId, families.refreshed[groupId]) {
        val session = families.begin() ?: return@LaunchedEffect
        val read = families.run(session) { sync -> FamilyPlan.read(sync.vault.context, sync.vault.api.session, groupId) } ?: return@LaunchedEffect
        read.getOrNull()?.let { plan = it }
    }
    val shown = plan ?: return
    val lines = FamilyPlanLines.of(shown, families.details[groupId]?.members)
    val alpine = Alpine.colors
    Subheader("Plan")
    Text(lines.plan, style = MaterialTheme.typography.bodyLarge, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S4))
    for ((label, value) in lines.rows) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2).semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            Text(value, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, textAlign = TextAlign.End,
                modifier = Modifier.padding(start = AlpineSpace.S4).weight(1f, fill = false))
        }
    }
    Text(lines.note, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted,
        modifier = Modifier.fillMaxWidth().padding(horizontal = AlpineSpace.S4, vertical = AlpineSpace.S2))
}
