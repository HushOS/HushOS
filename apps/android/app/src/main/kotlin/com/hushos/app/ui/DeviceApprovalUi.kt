package com.hushos.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.ReportProblem
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.hushos.app.data.ApprovalAnswering
import com.hushos.app.data.ApprovalProblem
import com.hushos.app.data.ApprovalWire
import com.hushos.app.data.AskPhase
import com.hushos.app.data.DeviceApprovals
import com.hushos.app.data.DeviceAsk
import com.hushos.app.data.KitScan
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.Problems
import com.hushos.app.data.PromptLimit
import com.hushos.app.data.Shared
import com.hushos.app.data.StepAnswer
import com.hushos.app.data.StepWords
import com.hushos.core.ApprovalPrompt
import com.hushos.core.approvalAsks
import com.hushos.core.approvalQrRead
import com.hushos.core.approvalWords
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * Approve on another device (docs/two-step-design.md 12), on this phone's screens: the panel the
 * asking side shows (a QR code, then the code to type on the other device), and the answering
 * side's list, banner and sheet. The order of every request, and every check, is `data/DeviceApproval.kt`'s
 * (`DeviceAsk`, `ApprovalAnswering`); nothing here decides what is revealed, approved or signed.
 * The twin of the iPhone app's `App/DeviceApproval.swift`.
 */

/* MARK: Asking */

/*
 * One request to another device, as a screen follows it: made on a press, looked at every two
 * seconds while its screen is up, and answered with once approved. It runs in the view model's
 * scope and is held there or in a retained holder, so a screen rebuilt meanwhile (a rotation, a
 * fold) finds it as it stands; whoever holds it lets it go (`stop`) when its screen goes for good.
 */
internal class DeviceAskModel(private val scope: CoroutineScope, private val name: () -> String, private val every: Long = DeviceAsk.EVERY_MS) {
    class Request(
        val wire: ApprovalWire,
        val token: String,
        /* `login`, a change's purpose, or `device-approval`. */
        val purpose: String,
        /* This phone's device key, base64url. */
        val key: String,
    )

    private class Following(val ask: DeviceAsk, val approved: suspend (StepAnswer) -> Unit, val failed: (Throwable) -> Unit)

    var phase by mutableStateOf<AskPhase>(AskPhase.Idle)
        private set

    /* What the request that is out, or was last out, answers its step with: a lost reply sends the same one again. */
    var answer: StepAnswer? = null
        private set

    private var job: Job? = null
    private var run = 0
    private var current: Following? = null

    val idle: Boolean get() = phase is AskPhase.Idle

    /*
     * Makes the request and follows it. `approved` hears the answer once another device approved,
     * and never before; `step-pending` thrown from it keeps waiting. `failed` hears why the request
     * could not be made, or what `approved` threw: nothing is out then.
     */
    fun begin(request: Request, approved: suspend (StepAnswer) -> Unit, failed: (Throwable) -> Unit) {
        stop()
        val mine = run
        phase = AskPhase.Starting
        job = scope.launch {
            val ask = try {
                withContext(Dispatchers.IO) { DeviceAsk.start(request.wire, request.token, request.purpose, request.key, name()) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (run == mine) { phase = AskPhase.Idle; failed(error) }
                return@launch
            }
            if (run != mine) return@launch
            answer = ask.answer
            val following = Following(ask, approved, failed)
            current = following
            phase = AskPhase.Waiting(ask.qr)
            follow(following, mine)
        }
    }

    /* The answer went out before the approval had landed (`step-pending`): the same request is waited on again. */
    fun resume() {
        val following = current ?: return
        if (phase !is AskPhase.Approved) return
        val mine = run
        job?.cancel()
        job = scope.launch { follow(following, mine) }
    }

    private suspend fun follow(following: Following, mine: Int) {
        try {
            following.ask.answered(every, shown = { state -> if (run == mine) show(state, following.ask.qr) }, answer = following.approved)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            if (run != mine) return
            phase = AskPhase.Idle
            following.failed(error)
        }
    }

    private fun show(state: DeviceAsk.State, qr: String) {
        phase = when (state) {
            DeviceAsk.State.Waiting -> AskPhase.Waiting(qr)
            is DeviceAsk.State.Code -> AskPhase.Code(state.code)
            DeviceAsk.State.Approved -> AskPhase.Approved
            is DeviceAsk.State.Ended -> AskPhase.Ended(StepWords.ended(state.why))
        }
    }

    /* Lets the request go: nothing is looked at again, and nothing of it is shown. The server ends it with its token. */
    fun stop() {
        run++
        job?.cancel()
        job = null
        current = null
        answer = null
        phase = AskPhase.Idle
    }
}

/* The asking side's panel: the QR code until a device opens the request, then the code, then how it ended. */
@Composable
internal fun DeviceAskPanel(phase: AskPhase, inlineAgain: Boolean, enabled: Boolean = true, again: () -> Unit) {
    val alpine = Alpine.colors
    when (phase) {
        AskPhase.Idle -> {}
        AskPhase.Starting -> Box(Modifier.fillMaxWidth().heightIn(min = 48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
        is AskPhase.Waiting -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4)) {
            val bitmap = remember(phase.qr) { runCatching { qrBitmap(phase.qr, 624) }.getOrNull() }
            // Dark on white in every theme, with its quiet zone: scanners expect it.
            if (bitmap != null) Box(Modifier.background(Color.White, RoundedCornerShape(12.dp)).padding(AlpineSpace.S3)) {
                Image(bitmap.asImageBitmap(), contentDescription = "QR code for your other device", modifier = Modifier.size(208.dp))
            }
            Text(StepWords.ASK_OPEN, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, textAlign = TextAlign.Center)
        }
        is AskPhase.Code -> Column(
            Modifier.fillMaxWidth().semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2),
        ) {
            Text(StepWords.ASK_CODE, style = MaterialTheme.typography.titleSmall, color = alpine.ink)
            Text(phase.code, style = MaterialTheme.typography.displaySmall.copy(fontFamily = FontFamily.Monospace), fontWeight = FontWeight.Bold, color = alpine.ink, maxLines = 1)
        }
        AskPhase.Approved -> Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.CheckCircle, null, tint = alpine.success)
            Text(StepWords.APPROVED, style = MaterialTheme.typography.bodyLarge, color = alpine.success, modifier = Modifier.padding(start = AlpineSpace.S2))
        }
        is AskPhase.Ended -> Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(phase.line, style = MaterialTheme.typography.bodyMedium, color = alpine.ink, textAlign = TextAlign.Center, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            // A form has no button of its own for it: Ask again sits in the panel. The sign-in screen's own button asks again.
            if (inlineAgain) TextButton(onClick = again, enabled = enabled) { Text(StepWords.ASK_AGAIN) }
        }
    }
}

/* MARK: Answering */

/*
 * The requests this phone may answer now, after its own limit of five a day for each class
 * (`PromptLimit`). Read when the app comes to the front, every five seconds while Account is on
 * screen, and when a push arrives; Home's banner and Devices' rows show them. Held by the view
 * model, with the request being answered: its sheet is `Main`'s, and survives a rebuilt screen.
 */
internal class ApprovalInbox(
    private val context: Context,
    private val scope: CoroutineScope,
    private val sessionEnded: (Shared.Session?) -> Unit,
    /* A brief confirmation, or (`important`) a line that stays until it is read. */
    private val notify: (said: String, important: Boolean) -> Unit,
) {
    var prompts by mutableStateOf<List<ApprovalPrompt>>(emptyList())
        private set

    /* The request being answered. */
    var answering by mutableStateOf<ApprovalAnswer?>(null)
        private set

    private var loading = false
    /* The session the list is for: another account's requests are never shown under this one. */
    private var owner: Shared.Session? = null
    /* Each request as it was first listed, before this phone opened it: what its reveal is checked against. */
    private val first = mutableMapOf<String, ApprovalPrompt>()
    private val flows = mutableMapOf<String, ApprovalAnswering>()
    /* This phone's own account id and device key, as read with the list. */
    private var identity: Shared.DeviceIdentity? = null

    fun load() { scope.launch { loadNow() } }

    suspend fun loadNow() {
        if (loading) return
        loading = true
        try {
            val session = withContext(Dispatchers.IO) { Shared.session(context) }
            // A phone with no device key for this account can approve nothing, and asks nothing.
            val own = withContext(Dispatchers.IO) { DeviceApprovals.identity(session, Shared.deviceIdentity(context)) }
            if (session == null || own == null) { clear(); return }
            if (owner != session) { clear(); owner = session }
            identity = own
            val listed = withContext(Dispatchers.IO) { runCatching { DeviceApprovals.list(ApprovalWire.signedIn(session), PromptLimit.stored(context)) } }
            // Kept as it was when the server can't be asked: the next look asks again.
            val list = listed.getOrElse { failure -> if (failure is NotAuthenticated) sessionEnded(session); return }
            if (owner != session) return
            for (asked in list) first.getOrPut(asked.id) { asked }
            val live = list.map { it.id }.toSet() + listOfNotNull(answering?.id)
            first.keys.retainAll(live)
            flows.keys.retainAll(live)
            prompts = list
        } finally {
            loading = false
        }
    }

    /* Answer: the request's sheet, over whatever is on screen. */
    fun answer(asked: ApprovalPrompt) {
        val session = owner ?: return
        val own = identity ?: return
        val flow = flows.getOrPut(asked.id) { ApprovalAnswering(first[asked.id] ?: asked, ApprovalWire.signedIn(session), own.userId, own.seed) }
        answering?.cancel()
        answering = ApprovalAnswer(flow, scope, closed = { said, important -> notify(said, important); finished(flow.id) }, sessionEnded = { dismiss(); sessionEnded(session) })
    }

    /* The sheet was closed without an answer: the request stays in the list until it is answered or over. */
    fun dismiss() {
        answering?.cancel()
        answering = null
    }

    /* Approved, denied or over: it leaves the list at once, without waiting for the next look. */
    private fun finished(id: String) {
        prompts = prompts.filterNot { it.id == id }
        first.remove(id)
        flows.remove(id)
        if (answering?.id == id) answering = null
    }

    fun clear() {
        answering?.cancel()
        answering = null
        prompts = emptyList()
        first.clear()
        flows.clear()
        owner = null
        identity = null
    }
}

/*
 * Answering one request, as its sheet follows it: scan the other screen's QR code, and this phone
 * checks that it is this very request before anything is asked; or type the code that screen shows.
 * Only then Approve. Deny and This wasn’t me end it at any point. Anything that does not match ends
 * it and says so. In the view model's scope: the sheet is only its view.
 */
internal class ApprovalAnswer(
    private val flow: ApprovalAnswering,
    private val scope: CoroutineScope,
    /* Approved, denied, or over: what to say as the sheet closes. */
    private val closed: (said: String, important: Boolean) -> Unit,
    private val sessionEnded: () -> Unit,
    private val every: Long = DeviceAsk.EVERY_MS,
) {
    enum class Phase { CHOOSE, SCANNING, WAITING, TYPING, CONFIRM }

    val id: String get() = flow.id
    val asks: String get() = flow.asks

    var phase by mutableStateOf(Phase.CHOOSE)
        private set
    var typed by mutableStateOf("")
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf("")
        private set

    private var work: Job? = null
    private var turn = 0

    /* The digits as typed, and the word begun after them. */
    private val digits: String get() = typed.takeWhile { it in '0'..'9' }
    private val word: String get() = typed.dropWhile { !it.isLetter() }.lowercase()

    /* Words the beginning could become; none once it is one of them and nothing longer. */
    val completions: List<String> get() = approvalWords(word, 6u).let { found -> if (found == listOf(word)) emptyList() else found }

    fun type(text: String) { typed = text.take(24); error = "" }
    fun complete(completion: String) { typed = "$digits $completion"; error = "" }

    /* Scan the code: the camera, once it may be used. */
    fun scan() { if (!busy) { error = ""; phase = Phase.SCANNING } }
    fun choose() { if (!busy) phase = Phase.CHOOSE }

    /* One piece of work at a time: a later one (Deny over a wait) takes over, and an earlier one that ends afterwards changes nothing. */
    private fun run(block: suspend () -> Unit) {
        val mine = ++turn
        work = scope.launch {
            try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                if (turn == mine) failed(failure)
            } finally {
                if (turn == mine) busy = false
            }
        }
    }

    /* Type the code: the request is opened, and the field appears once the other device has revealed what it committed to. */
    fun typing() {
        if (busy) return
        error = ""
        phase = Phase.WAITING
        run {
            withContext(Dispatchers.IO) { flow.open() }
            flow.awaitReveal(every)
            phase = Phase.TYPING
        }
    }

    /* What the camera read. Anything that is not an approval's code is passed over; this request's own opens it. */
    fun scanned(text: String) {
        // Another QR code in view is not looked at twice, and holds nothing up.
        if (busy || phase != Phase.SCANNING || approvalQrRead(text) == null) return
        busy = true
        run {
            if (!withContext(Dispatchers.IO) { flow.openScanned(text) }) return@run
            phase = Phase.WAITING
            busy = false
            flow.awaitReveal(every)
            phase = Phase.CONFIRM
        }
    }

    /* Approve: with what was typed, or after a scan with nothing typed. */
    fun approve() {
        if (busy || (phase != Phase.TYPING && phase != Phase.CONFIRM)) return
        val code = typed.takeIf { phase == Phase.TYPING }
        busy = true
        error = ""
        run {
            withContext(Dispatchers.IO) { flow.approve(code) }
            closed(StepWords.APPROVED, false)
        }
    }

    /* Deny, or This wasn’t me. */
    fun end(why: ApprovalAnswering.Ending) {
        if (busy) return
        busy = true
        error = ""
        work?.cancel()
        run {
            withContext(Dispatchers.IO) { flow.end(why) }
            closed(StepWords.DENIED, false)
        }
    }

    /* A request that is over, or that did not match, closes with why. Anything else stays, to be tried again. */
    private fun failed(failure: Exception) {
        when (failure) {
            is ApprovalProblem -> closed(failure.message ?: Problems.SERVER, true)
            // An ended session is said by the app as everywhere; nothing of this account's is left to answer.
            is NotAuthenticated -> sessionEnded()
            else -> {
                if (phase == Phase.WAITING || phase == Phase.SCANNING) phase = Phase.CHOOSE
                error = Problems.say(failure, Problems.SERVER)
            }
        }
    }

    /* The sheet went: nothing goes on behind it. */
    fun cancel() { turn++; work?.cancel() }
}

/* One waiting request as a row: what is asked and by which device, and Answer. */
@Composable
internal fun ApprovalRow(text: String, modifier: Modifier = Modifier, onAnswer: () -> Unit) {
    Row(modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = AlpineSpace.S4, end = AlpineSpace.S2, top = AlpineSpace.S2, bottom = AlpineSpace.S2), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.bodyLarge, color = Alpine.colors.ink, modifier = Modifier.weight(1f))
        TextButton(onClick = onAnswer) { Text(StepWords.APPROVAL_ANSWER) }
    }
}

/* Devices' rows: each request with what is asked and by which device. Nothing while none is waiting. */
@Composable
internal fun ApprovalRows(inbox: ApprovalInbox) {
    for (asked in inbox.prompts) ApprovalRow(approvalAsks(asked.purpose, asked.deviceName)) { inbox.answer(asked) }
}

/* Home's banner while a request is waiting: said first, with the way to answer. */
@Composable
internal fun ApprovalBanner(inbox: ApprovalInbox) {
    val asked = inbox.prompts.firstOrNull() ?: return
    val alpine = Alpine.colors
    ApprovalRow(
        StepWords.APPROVAL_WAITING,
        Modifier.padding(horizontal = AlpineSpace.S4).padding(bottom = AlpineSpace.S2).background(alpine.card, RoundedCornerShape(12.dp)).semantics { liveRegion = LiveRegionMode.Polite },
    ) { inbox.answer(asked) }
}

/* Whether this phone has a camera to scan with; without one, typing remains. */
private fun hasCamera(context: Context): Boolean = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

/* The answer sheet, drawn by `Main` while a request is being answered. */
@Composable
internal fun ApprovalSheet(inbox: ApprovalInbox, answer: ApprovalAnswer) {
    val alpine = Alpine.colors
    val context = LocalContext.current
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) answer.scan() }
    val busy = answer.busy
    Sheet(onDismissRequest = { if (!busy) inbox.dismiss() }) {
        // The sheet itself rises over the keyboard: nothing here pays that inset again.
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = AlpineSpace.S4)) {
            // What is asked, and by which device, whole: never cut short.
            Text(answer.asks, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = alpine.ink,
                modifier = Modifier.padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S3).semantics { heading() })
            when (answer.phase) {
                ApprovalAnswer.Phase.CHOOSE -> {
                    if (hasCamera(context)) SheetRow("Scan the code", Icons.Outlined.QrCodeScanner, action = true) {
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) answer.scan()
                        else permission.launch(Manifest.permission.CAMERA)
                    }
                    SheetRow("Type the code", Icons.Outlined.Keyboard, action = true) { answer.typing() }
                }
                ApprovalAnswer.Phase.SCANNING -> Column(Modifier.padding(horizontal = AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                    // Only an approval's own code ends the scan; any other code in view is passed over.
                    QrCamera({ bytes, width, height, stride -> KitScan.decode(bytes, width, height, stride)?.takeIf { approvalQrRead(it) != null } }) { answer.scanned(it) }
                    TextButton(onClick = { answer.choose() }, enabled = !busy) { Text("Cancel") }
                }
                ApprovalAnswer.Phase.WAITING -> Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = AlpineSpace.S6), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                    Text(StepWords.ASK_WAITING, style = MaterialTheme.typography.bodyLarge, color = alpine.inkMuted, modifier = Modifier.padding(start = AlpineSpace.S4))
                }
                ApprovalAnswer.Phase.TYPING -> Column(Modifier.padding(horizontal = AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                    OutlinedTextField(
                        value = answer.typed, onValueChange = answer::type, label = { Text(StepWords.APPROVAL_CODE_FIELD) }, placeholder = { Text("47 river") },
                        singleLine = true, enabled = !busy, textStyle = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { answer.approve() }), modifier = Modifier.fillMaxWidth(),
                    )
                    val completions = answer.completions
                    if (completions.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
                        for (completion in completions) SuggestionChip(onClick = { answer.complete(completion) }, enabled = !busy, label = { Text(completion) })
                    }
                    ApproveButton(busy) { answer.approve() }
                }
                ApprovalAnswer.Phase.CONFIRM -> Box(Modifier.padding(horizontal = AlpineSpace.S6)) { ApproveButton(busy) { answer.approve() } }
            }
            if (answer.error.isNotEmpty()) Text(
                answer.error, color = alpine.danger, style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2).semantics { liveRegion = LiveRegionMode.Polite },
            )
            SheetRow("Deny", Icons.Outlined.Block, enabled = !busy) { answer.end(ApprovalAnswering.Ending.DENIED) }
            SheetRow("This wasn’t me", Icons.Outlined.ReportProblem, danger = true, enabled = !busy) { answer.end(ApprovalAnswering.Ending.NOT_ME) }
        }
    }
}

@Composable
private fun ApproveButton(busy: Boolean, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(top = AlpineSpace.S2).height(48.dp)) { Text("Approve") }
}
