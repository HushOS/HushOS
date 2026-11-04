package com.hushos.app.data

import org.json.JSONObject

/*
 * A family's plan as `GET /api/billing/groups/:id` serves it to this person (packages/billing/src/api.ts,
 * GroupBillingSummary): the payer and anyone holding `billing` get the manager's summary, everyone else the member's
 * glance (the plan's name and the pool, and who pays only when it is them). Read only on the phone, as all billing is
 * (docs/groups-mobile-plan.md, iOS 7 and Android 7): no price, place, checkout, portal or way to change it.
 */
data class FamilyPlan(
    /* The live plan's tier ("Family Pro", without "(monthly)"); null while none is live. */
    val name: String?,
    /* A plan Polar still holds whose payment failed, or that is paused, while none is live. */
    val lapsed: LapsedPlan?,
    /* The family's pool: every family folder and pooled member's files against the plan's storage. */
    val usedBytes: Long?,
    val quotaBytes: Long?,
    val payer: Payer?,
) {
    sealed interface Payer {
        data object You : Payer
        data class Member(val userId: String) : Payer
    }

    companion object {
        private val interval = Regex("""\s*\((monthly|yearly|annual)\)\s*$""", RegexOption.IGNORE_CASE)

        /* The web's planTierName: "Family Pro (monthly)" is "Family Pro". */
        fun tierName(productName: String): String = productName.replace(interval, "")

        /* Null when billing is off on this server, or the answer isn't one this build reads. */
        fun from(json: JSONObject): FamilyPlan? {
            if (json.opt("enabled") != true) return null
            val storage = json.optJSONObject("storage")
            val used = (storage?.opt("usedBytes") as? String)?.toLongOrNull()
            val quota = (storage?.opt("quotaBytes") as? String)?.toLongOrNull()
            val lapsedJson = json.optJSONObject("lapsedPlan")
            val lapsed = (lapsedJson?.opt("productName") as? String)?.takeIf { it.isNotBlank() }?.let { LapsedPlan.of(it, lapsedJson.opt("standing") == "paused") }
            return when (json.opt("view")) {
                "member" -> FamilyPlan(
                    (json.opt("planName") as? String)?.takeIf { json.opt("hasPlan") == true && it.isNotBlank() }?.let(::tierName),
                    lapsed, used, quota,
                    // The glance names nobody who pays, but tells the payer it is them.
                    if (lapsedJson?.opt("youPay") == true) Payer.You else null,
                )
                "manage" -> {
                    val payer = json.optJSONObject("payer")?.let { p ->
                        if (p.opt("you") == true) Payer.You else (p.opt("userId") as? String)?.takeIf { it.isNotEmpty() }?.let { Payer.Member(it) }
                    }
                    val live = (json.optJSONObject("subscription")?.opt("productName") as? String)?.takeIf { it.isNotBlank() }?.let(::tierName)
                    FamilyPlan(live, if (live == null) lapsed else null, used, quota, payer)
                }
                else -> null
            }
        }

        /* What the section shows after a read: what it read, none included (billing turned off); the plan before only when the read failed. */
        fun after(previous: FamilyPlan?, read: Result<FamilyPlan?>): FamilyPlan? = read.fold({ it }, { previous })

        /* The family's plan, read for `session` (a member of the family). */
        fun read(context: android.content.Context, session: Shared.Session, groupId: String): FamilyPlan? {
            if (!FamilyRecords.valid(groupId.lowercase())) return null
            return from(Auth.familyBilling(context, groupId.lowercase(), session))
        }
    }
}
