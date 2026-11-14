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
import com.hushos.app.data.AuthFailure
import com.hushos.app.data.DeviceApprovals
import com.hushos.app.data.DeviceAsk
import com.hushos.app.data.DeviceEnrolment
import com.hushos.app.data.KitScan
import com.hushos.app.data.NotAuthenticated
import com.hushos.app.data.OpenedValues
import com.hushos.app.data.Problems
import com.hushos.app.data.PromptLimit
import com.hushos.app.data.Shared
import com.hushos.app.data.StepAnswer
import com.hushos.app.data.StepRefused
import com.hushos.app.data.StepWords
import com.hushos.app.data.TwoStep
import com.hushos.app.data.TwoStepFlow
import com.hushos.app.data.TwoStepStatus
import com.hushos.core.ApprovalPrompt
import com.hushos.core.StepProof
import com.hushos.core.StepRefusal
import com.hushos.core.approvalCodeNormalize
import com.hushos.core.approvalQrRead
import com.hushos.core.approvalWords
import com.hushos.tokens.AlpineSpace
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * Approve on another device (docs/two-step-design.md 12), on this phone's screens: the panel the
 * asking side shows (a QR code, then the code to type on the other device), and the answering
 * side's list, banner and sheet. The order of every request, and every check, is `data/DeviceApproval.kt`'s
 * (`DeviceAsk`, `ApprovalAnswering`); nothing here decides what is revealed, approved or signed.
 * Turning the method on runs the code the other way: the asking page shows no code and no QR code
 * and takes the code typed, and the answering sheet approves on a press and then shows it.
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
        /* Turning the method on: the device the person chose to approve, the only one that may answer. Null for a sign-in and a change. */
        val approverDeviceId: String? = null,
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
                withContext(Dispatchers.IO) { DeviceAsk.start(request.wire, request.token, request.purpose, request.key, name(), request.approverDeviceId) }
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
            phase = waiting(ask.qr)
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

    /* Before a device opened the request: its QR code, or for the one that turns the method on (which has none) only that it was asked. */
    private fun waiting(qr: String?): AskPhase = qr?.let { AskPhase.Waiting(it) } ?: AskPhase.Asked

    private fun show(state: DeviceAsk.State, qr: String?) {
        phase = when (state) {
            DeviceAsk.State.Waiting -> waiting(qr)
            is DeviceAsk.State.Code -> AskPhase.Code(state.code)
            DeviceAsk.State.Opened -> AskPhase.Asked
            DeviceAsk.State.Approved -> AskPhase.Approved
            is DeviceAsk.State.Ended -> AskPhase.Ended(StepWords.ended(state.why))
        }
    }

    /*
     * Turning the method on: what was typed here from the approving device's screen, as it is written, when it is
     * exactly the code this phone worked out for the request that is out; else null (`DeviceAsk.matches`).
     */
    fun matches(typed: String): String? = current?.ask?.matches(typed)

    /* Lets the request go: nothing is looked at again, and nothing of it is shown. The server ends it with its token. */
    fun stop() {
        run++
        job?.cancel()
        job = null
        current = null
        answer = null
        phase = AskPhase.Idle
    }

    /* Gives the request up from here, saying why: let go as by `stop`, with nothing sent, and the panel offers Ask again. */
    fun drop(line: String) {
        stop()
        phase = AskPhase.Ended(line)
    }
}

/*
 * A code from another device's screen as it is typed: two digits and a word, with the words the typed beginning
 * could become. The answer sheet's field and the page that turns the method on both hold one.
 */
internal class CodeEntry {
    var typed by mutableStateOf("")
        private set

    /* The digits as typed, and the word begun after them. */
    private val digits: String get() = typed.takeWhile { it in '0'..'9' }
    private val word: String get() = typed.dropWhile { !it.isLetter() }.lowercase()

    /* Words the beginning could become; none once it is one of them and nothing longer. */
    val completions: List<String> get() = approvalWords(word, 6u).let { found -> if (found == listOf(word)) emptyList() else found }

    /* What is typed is a code, whichever one: two digits and a word of the list, however it was spaced or cased. */
    val isCode: Boolean get() = approvalCodeNormalize(typed) != null

    fun type(text: String) { typed = text.take(24) }
    fun complete(completion: String) { typed = "$digits $completion" }
    fun clear() { typed = "" }
}

/* MARK: Turning the method on */

/*
 * Turning on Approve on another device, as Account › Two-step sign-in follows it (docs/two-step-design.md 12,
 * "Turning it on first"): the password, the device the person chose to approve, the request to that device and
 * no other, the code that device shows once it approved, typed here, the confirmation with that code, and behind
 * the backup codes the removal of the other devices but that one.
 *
 * The approval alone confirms nothing. The list the device was chosen from is made of the devices' own words, so
 * the device that approved has to be one the person is holding: it shows the code, and only a person who can read
 * its screen can type it here. This phone shows neither a code nor a QR code for this request.
 *
 * It runs in the view model's scope, and what it made is the view model's flow (`TwoStepFlow`), so a screen
 * rebuilt meanwhile finds it. Everything that reaches the server is handed in, so the order of things is tested
 * without a server or a screen (`DeviceSetupTest`).
 */
internal class DeviceSetupModel(
    private val scope: CoroutineScope,
    /* The request to the other device, as the page shows it. */
    val ask: DeviceAskModel,
    private val flow: () -> TwoStepFlow,
    private val set: (TwoStepFlow) -> Unit,
    /* Moves on with every sign-in and sign-out: what comes back for an earlier session is dropped. */
    private val era: () -> Int,
    /* `two-step/device`: the pending method, for the password and (once the step is on) the step. */
    private val start: suspend (password: String, twoStep: StepAnswer?) -> Result<DeviceEnrolment>,
    /* What the chosen device is asked with: this session and this phone's device key. Null with neither. */
    private val request: (token: String, approverDeviceId: String) -> DeviceAskModel.Request?,
    /* `two-step/device/:id/confirm`, with the request that device approved and the code it shows, as typed here and written by the core. */
    private val confirm: suspend (started: DeviceEnrolment, requestId: String, code: String) -> Result<TwoStep.DeviceConfirmed>,
    /* `DELETE devices/others`, keeping the device that approved (`keep`). */
    private val removeOthers: (password: String, keep: String, done: (Boolean) -> Unit) -> Unit,
    private val sessionEnded: (Shared.Session?) -> Unit,
    /* How long a confirmation that found the approval not landed yet (`step-pending`) waits before it goes again. */
    private val every: Long = DeviceAsk.EVERY_MS,
) {
    /* What the page was sent with: kept in memory from Continue until the method is on, the setup failed, or the page was left. */
    private class Setup(val password: String, val first: Boolean, val signOutOthers: Boolean)

    private var setup: Setup? = null

    /* The request the chosen device approved, until its code was typed here or it was dropped. It confirms nothing by itself. */
    private var approvedId by mutableStateOf<String?>(null)

    /* The chosen device approved and shows the code now: the page asks for it, with Turn on (or Add). */
    val ready: Boolean get() = approvedId != null

    /* The code as it is typed here, from the chosen device's screen. */
    val code = CodeEntry()

    /*
     * Continue: the pending method, then the chosen device is asked at once (Continue was the press). `first`: the
     * account has no method yet, so this turns the step on. Nothing at all is sent without a device chosen to
     * approve, and none is ever chosen for the person: with the step off, a request any signed-in device could
     * answer would let one that someone else opened with the password answer first.
     */
    fun begin(password: String, twoStep: StepAnswer?, first: Boolean, approver: TwoStepStatus.Approver?, signOutOthers: Boolean, failed: suspend (Throwable) -> String?) {
        approver ?: return
        if (flow().pending) return
        set(flow().started())
        val mine = era()
        scope.launch {
            val answer = start(password, twoStep)
            val words = answer.exceptionOrNull()?.let { if (it is NotAuthenticated) null else failed(it) }
            if (mine != era()) return@launch
            answer.fold(
                { started ->
                    setup = Setup(password, first, signOutOthers)
                    set(flow().deviceStarted(started, approver))
                    askAgain()
                },
                { failure -> set(flow().failed(failure, words)) },
            )
        }
    }

    /*
     * Asks the chosen device, and no other, to approve the pending method. From a press only (Continue, or Ask
     * again), and every request names the same device. One at a time: asked when nothing is out, or again once the
     * last one ended. A request that could not be made goes back to the password with why, in the server's words.
     *
     * Its approval sends nothing: it only brings up the field for the code that device then shows (`turnOn`).
     */
    fun askAgain() {
        val now = flow()
        val started = now.device ?: return
        val approver = now.approver ?: return
        if (setup == null) return
        if (now.pending || !(ask.phase is AskPhase.Idle || ask.phase is AskPhase.Ended)) return
        val mine = era()
        val request = request(started.token, approver.id) ?: run { back(AuthFailure(Problems.SERVER)); return }
        approvedId = null
        code.clear()
        ask.begin(
            request,
            approved = { answer ->
                val requestId = (answer.proof as? StepProof.Device)?.requestId
                if (requestId != null && mine == era() && flow().device == started) approvedId = requestId
            },
            failed = { failure ->
                if (failure is NotAuthenticated) sessionEnded(request.wire.session)
                if (mine == era() && flow().device != null) back(failure)
            },
        )
    }

    /*
     * Turn on, or Add: the press under the code. What was typed is checked here first, against the code this phone
     * worked out itself for the approved request (`DeviceAsk.matches`), and the server checks it again.
     *
     * - One try. A code that is not the request's sends nothing: the request is dropped here, the page says so, and
     *   Ask again makes a new one to the same device. Something that is no code at all changes nothing.
     * - The confirmation is the request that may turn the step on and make the backup codes, which the server shows
     *   once. The flow is pending from before it goes out, so Back and leaving the page are held (`left`) until it
     *   has answered, and what it answered is put in the flow in the view model's scope: a page or a request let go
     *   meanwhile still leaves the codes where the page finds them, until Done.
     * - The codes first; only then, when this turned the step on with the box ticked, are the other devices removed,
     *   all but the one that approved. A removal that fails never costs the codes.
     * - A lost reply says HushOS can't tell whether it was turned on, and the settings are read again (`deviceFailed`).
     *   So does a refusal, the server's own of the code included (`device-code`), in its words.
     * - `step-pending` (the approval had not landed where the confirmation went) changed and counted nothing: the
     *   same confirmation goes again, a few times, before it is said as a failure.
     */
    fun turnOn() {
        val now = flow()
        val started = now.device ?: return
        val approver = now.approver ?: return
        val sent = setup ?: return
        val requestId = approvedId ?: return
        if (now.pending || !code.isCode) return
        val written = ask.matches(code.typed)
        if (written == null) {
            approvedId = null
            code.clear()
            ask.drop(StepWords.DEVICE_CODE_WRONG)
            return
        }
        val mine = era()
        set(flow().started())
        scope.launch {
            var result = confirm(started, requestId, written)
            var again = 0
            while (mine == era() && again++ < PENDING_TRIES && result.exceptionOrNull().let { it is StepRefused && it.refusal == StepRefusal.PENDING }) {
                delay(every)
                result = confirm(started, requestId, written)
            }
            if (mine != era()) return@launch
            result.fold(
                { made ->
                    forget()
                    set(flow().deviceConfirmed(made, sent.first))
                    if (TwoStepFlow.removesOthers(made is TwoStep.DeviceConfirmed.TurnedOn, sent.signOutOthers, sent.first)) {
                        set(flow().copy(removing = true))
                        removeOthers(sent.password, approver.id) { removed ->
                            if (mine == era() && flow().codes != null) set(flow().copy(removing = false, notRemoved = !removed))
                        }
                    }
                },
                { failure -> back(failure) },
            )
        }
    }

    /* Back to the password with why; any failure may hide a method that was turned on, so the settings are read again. */
    private fun back(failure: Throwable) {
        forget()
        set(flow().deviceFailed(failure))
    }

    /* The request to the other device, its approval, what was typed and what the page was sent with: all let go. */
    private fun forget() {
        ask.stop()
        setup = null
        approvedId = null
        code.clear()
    }

    /*
     * The page was opened or left: the request to the other device goes with it, and so does what the page was
     * sent with. Not while a request of the flow's is out (false: nothing was let go): the confirmation may be
     * making the backup codes, and its answer has to land.
     */
    fun left(): Boolean {
        if (flow().pending) return false
        forget()
        return true
    }

    /* The session went: everything of it goes, whatever is out. */
    fun end() = forget()

    companion object {
        /* How often a confirmation answered `step-pending` goes again before that is said as a failure. */
        const val PENDING_TRIES = 5
    }
}

/*
 * The asking side's panel: the QR code until a device opens the request, then the code, then how it ended.
 * `open`: what the person does on the other device, naming it when one was chosen to approve.
 */
@Composable
internal fun DeviceAskPanel(phase: AskPhase, inlineAgain: Boolean, enabled: Boolean = true, open: String = StepWords.ASK_OPEN, again: () -> Unit) {
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
            Text(open, style = MaterialTheme.typography.bodyMedium, color = alpine.inkMuted, textAlign = TextAlign.Center)
        }
        // Turning the method on: no QR code and no code here, only which device to pick up.
        AskPhase.Asked -> Text(open, style = MaterialTheme.typography.bodyLarge, color = alpine.ink, modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
        is AskPhase.Code -> ShownCode(phase.code)
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

/* A code for the person to type on their other device, under its label: large and monospaced, read out when it appears. */
@Composable
internal fun ShownCode(code: String, modifier: Modifier = Modifier) {
    val alpine = Alpine.colors
    Column(
        modifier.fillMaxWidth().semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2),
    ) {
        Text(StepWords.ASK_CODE, style = MaterialTheme.typography.titleSmall, color = alpine.ink)
        Text(code, style = MaterialTheme.typography.displaySmall.copy(fontFamily = FontFamily.Monospace), fontWeight = FontWeight.Bold, color = alpine.ink, maxLines = 1)
    }
}

/*
 * Where a code from another device's screen is typed: two digits and a word, with the words the typed beginning
 * could become offered beneath. `onDone`: the keyboard's Done.
 */
@Composable
internal fun CodeField(label: String, typed: String, completions: List<String>, enabled: Boolean, onType: (String) -> Unit, onComplete: (String) -> Unit, onDone: () -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
        // A code that passes a second step: the keyboard must not learn it, as for every other answer to the step.
        NoKeyboardLearning {
            OutlinedTextField(
                value = typed, onValueChange = onType, label = { Text(label) }, placeholder = { Text("47 river") },
                singleLine = true, enabled = enabled, textStyle = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { onDone() }), modifier = Modifier.fillMaxWidth(),
            )
        }
        if (completions.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(AlpineSpace.S2)) {
            for (completion in completions) SuggestionChip(onClick = { onComplete(completion) }, enabled = enabled, label = { Text(completion) })
        }
    }
}

/* MARK: Answering */

/*
 * The requests this phone may answer now, after its own limit of five a day for each class
 * (`PromptLimit`). Read when the app comes to the front, every five seconds while Account is on
 * screen, and when a push arrives; Home's banner and Devices' rows show them. Held by the view
 * model, with the request being answered: its sheet is `Main`'s, and survives a rebuilt screen.
 *
 * Nothing here asks whether the server has two-step sign-in on (`TwoStep.status`, 501 where it is
 * off): that setting decides who can turn the step on, and an account that already has it is still
 * asked for it, so its requests are still listed and answered.
 *
 * Everything it holds is one account's: the list, the request being answered, and the values this
 * phone opened requests with. All of it goes the moment the phone's session is another one, before
 * anything else is looked at, and a list that comes back for a session that is no longer the
 * phone's shows nothing and is not counted: the limit's record is an account file too, written only
 * for a list known to be the account's that is signed in as it is written.
 */
internal class ApprovalInbox(
    private val scope: CoroutineScope,
    /* What this phone holds now: its session, and its device key. Read at every look, off the main thread. */
    private val held: () -> Shared.Session?,
    private val key: () -> Shared.DeviceIdentity?,
    private val wire: (Shared.Session) -> ApprovalWire,
    private val limit: () -> PromptLimit,
    private val sessionEnded: (Shared.Session?) -> Unit,
    /* A brief confirmation, or (`important`) a line that stays until it is read. */
    private val notify: (said: String, important: Boolean) -> Unit,
    /* What this phone opened requests with, in this process and under this account. */
    private val opened: OpenedValues = OpenedValues(),
) {
    constructor(context: Context, scope: CoroutineScope, sessionEnded: (Shared.Session?) -> Unit, notify: (said: String, important: Boolean) -> Unit) :
        this(scope, { Shared.session(context) }, { Shared.deviceIdentity(context) }, ApprovalWire::signedIn, { PromptLimit.stored(context) }, sessionEnded, notify)

    var prompts by mutableStateOf<List<ApprovalPrompt>>(emptyList())
        private set

    /* The request being answered. */
    var answering by mutableStateOf<ApprovalAnswer?>(null)
        private set

    /* The session a list is out for: one look at a time for each. */
    private var loading: Shared.Session? = null
    /* The session the list is for: another account's requests are never shown under this one. */
    private var owner: Shared.Session? = null
    /* Each request as it was first listed, before this phone opened it: what its reveal is checked against. */
    private val first = mutableMapOf<String, ApprovalPrompt>()
    private val flows = mutableMapOf<String, ApprovalAnswering>()
    /* This phone's own account id and device key, as read with the list. */
    private var identity: Shared.DeviceIdentity? = null

    fun load() { scope.launch { loadNow() } }

    suspend fun loadNow() {
        val session = withContext(Dispatchers.IO) { held() }
        // A phone with no device key for this account can approve nothing, and asks nothing.
        val own = withContext(Dispatchers.IO) { DeviceApprovals.identity(session, key()) }
        // Whose list this is comes first, ahead of the look already out: what was held for another session goes now,
        // not when that look comes back, and its answer then finds another owner and shows nothing.
        if (session == null || own == null) { clear(); return }
        if (owner != session) { clear(); owner = session }
        identity = own
        if (loading == session) return
        loading = session
        try {
            // Uncounted: whose list this is has to be known before the phone's own limit is written for it.
            val listed = withContext(Dispatchers.IO) { runCatching { DeviceApprovals.listed(wire(session)) } }
            if (owner != session) return
            // The session may have changed while the list was out with no look since to notice (a sign-in from a file
            // picker has its own view model): asked again before anything of the reply is shown or counted. The count
            // is kept in an account file (`approval-prompts.json`), so it is written only here, behind that check: a
            // late list of the account that was here before writes nothing into the next one's storage.
            val counted = withContext(Dispatchers.IO) { if (held() != session) null else listed.mapCatching { limit().shown(it) } }
            if (counted == null) { if (owner == session) clear(); return }
            if (owner != session) return
            // Kept as it was when the server can't be asked: the next look asks again.
            val list = counted.getOrElse { failure -> if (failure is NotAuthenticated) sessionEnded(session); return }
            for (asked in list) first.getOrPut(asked.id) { asked }
            val live = list.map { it.id }.toSet() + listOfNotNull(answering?.id)
            first.keys.retainAll(live)
            flows.keys.retainAll(live)
            opened.retain(live)
            prompts = list
        } finally {
            if (loading == session) loading = null
        }
    }

    /* Answer: the request's sheet, over whatever is on screen. */
    fun answer(asked: ApprovalPrompt) {
        val session = owner ?: return
        val own = identity ?: return
        val flow = flows.getOrPut(asked.id) { ApprovalAnswering(first[asked.id] ?: asked, wire(session), own.userId, own.seed, opened) }
        answering?.cancel()
        val sheet = ApprovalAnswer(
            flow, scope, closed = { said, important -> notify(said, important); finished(flow.id) }, sessionEnded = { dismiss(); sessionEnded(session) },
            // Approved, with its code up for the person to read: it leaves the list at once, and its sheet stays until Done.
            codeShown = { prompts = prompts.filterNot { it.id == flow.id } },
        )
        answering = sheet
        // Turning the method on has nothing to choose between: Answer was the press that opens the request.
        sheet.open()
    }

    /*
     * The sheet was closed. Without an answer the request stays in the list until it is answered or over; with its
     * code up it was approved already, and nothing of it is left to answer.
     */
    fun dismiss() {
        val was = answering ?: return
        was.cancel()
        answering = null
        if (was.code != null) finished(was.id)
    }

    /* Approved, denied or over: it leaves the list at once, without waiting for the next look. */
    private fun finished(id: String) {
        prompts = prompts.filterNot { it.id == id }
        first.remove(id)
        flows.remove(id)
        opened.forget(id)
        if (answering?.id == id) answering = null
    }

    fun clear() {
        answering?.cancel()
        answering = null
        prompts = emptyList()
        first.clear()
        flows.clear()
        opened.clear()
        owner = null
        identity = null
    }
}

/*
 * Answering one request, as its sheet follows it: scan the other screen's QR code, and this phone
 * checks that it is this very request before anything is asked; or type the code that screen shows.
 * Only then Approve. Deny and This wasn’t me end it at any point. Anything that does not match ends
 * it and says so. In the view model's scope: the sheet is only its view.
 *
 * The request that turns the method on is the other way round (`turnsOn`): nothing is scanned and
 * nothing typed here. It is opened as the sheet opens, Approve signs once the other device revealed,
 * and then the sheet shows the code for the person to type on the device that asked, until Done.
 *
 * `busy` is a request of this sheet's own on its way (the open after a scan, the approval, the denial).
 * Waiting for the other device to reveal is not: it can take minutes, and Deny, This wasn’t me and
 * closing the sheet all stay within reach meanwhile.
 */
internal class ApprovalAnswer(
    private val flow: ApprovalAnswering,
    private val scope: CoroutineScope,
    /* Approved, denied, or over: what to say as the sheet closes. */
    private val closed: (said: String, important: Boolean) -> Unit,
    private val sessionEnded: () -> Unit,
    private val every: Long = DeviceAsk.EVERY_MS,
    /* Turning the method on: approved, and its code is up. The sheet stays; the request is nobody's to answer any more. */
    private val codeShown: () -> Unit = {},
) {
    enum class Phase { CHOOSE, SCANNING, WAITING, TYPING, CONFIRM, SHOWING }

    val id: String get() = flow.id
    val asks: String get() = flow.asks

    /* The one line under what is asked: that the other device chose this phone to answer, when it did. */
    val note: String? get() = StepWords.APPROVAL_CHOSEN.takeIf { flow.chosen }

    /* The request turns the method on: no scan and no field, Approve on a press, then the code to show. */
    val turnsOn: Boolean get() = flow.turnsOn

    var phase by mutableStateOf(Phase.CHOOSE)
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf("")
        private set

    /* Turning the method on, once approved: the code for the person to type on the device that asked. Up until Done. */
    var code by mutableStateOf<String?>(null)
        private set

    private val entry = CodeEntry()
    val typed: String get() = entry.typed
    val completions: List<String> get() = entry.completions

    private var work: Job? = null
    private var turn = 0

    fun type(text: String) { entry.type(text); error = "" }
    fun complete(completion: String) { entry.complete(completion); error = "" }

    /* Scan the code: the camera, once it may be used. Never for the request that turns the method on. */
    fun scan() { if (!busy && !turnsOn && phase != Phase.SHOWING) { error = ""; phase = Phase.SCANNING } }
    fun choose() { if (!busy && phase != Phase.SHOWING) phase = Phase.CHOOSE }

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
        if (busy || turnsOn || phase == Phase.SHOWING) return
        error = ""
        phase = Phase.WAITING
        run {
            withContext(Dispatchers.IO) { flow.open() }
            flow.awaitReveal(every)
            phase = Phase.TYPING
        }
    }

    /*
     * Turning the method on: the request is opened and the reveal awaited exactly as for a typed code, and then
     * only Approve is asked. Answer was the press (the inbox calls this as the sheet opens); Try again is the
     * press after an open that got no answer. Nothing for any other request, which is opened by a scan or by
     * choosing to type.
     */
    fun open() {
        if (!turnsOn || busy || phase != Phase.CHOOSE) return
        error = ""
        phase = Phase.WAITING
        run {
            withContext(Dispatchers.IO) { flow.open() }
            flow.awaitReveal(every)
            phase = Phase.CONFIRM
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
            // Opened: from here it only waits for the other device, which holds nothing up.
            busy = false
            flow.awaitReveal(every)
            phase = Phase.CONFIRM
        }
    }

    /*
     * Approve: with what was typed, or after a scan with nothing typed. The request that turns the method on is
     * approved on the press alone, and its code then stays up (`SHOWING`): nothing closes the sheet but Done.
     */
    fun approve() {
        if (busy || (phase != Phase.TYPING && phase != Phase.CONFIRM)) return
        val written = typed.takeIf { phase == Phase.TYPING }
        busy = true
        error = ""
        run {
            val shown = withContext(Dispatchers.IO) { flow.approve(written) }
            if (shown == null) closed(StepWords.APPROVED, false)
            else {
                code = shown
                phase = Phase.SHOWING
                codeShown()
            }
        }
    }

    /* Done, under the code: the person has typed it on the other device, or will not. */
    fun done() { if (phase == Phase.SHOWING) closed(StepWords.APPROVED, false) }

    /* Deny, or This wasn’t me. Over a wait too: only a request of this sheet's own on its way holds it. */
    fun end(why: ApprovalAnswering.Ending) {
        if (busy || phase == Phase.SHOWING) return
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
    for (asked in inbox.prompts) ApprovalRow(DeviceApprovals.asks(asked)) { inbox.answer(asked) }
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

/*
 * The answer sheet, drawn by `Main` while a request is being answered. It can be closed whenever no request of
 * its own is on its way (`busy`): waiting for the other device holds nothing.
 */
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
            answer.note?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = alpine.ink, modifier = Modifier.padding(horizontal = AlpineSpace.S6).padding(bottom = AlpineSpace.S3)) }
            when (answer.phase) {
                // Turning the method on is never scanned or typed here: this is only where an open that got no answer is asked again.
                ApprovalAnswer.Phase.CHOOSE -> if (answer.turnsOn) {
                    TextButton(onClick = { answer.open() }, modifier = Modifier.padding(horizontal = AlpineSpace.S4)) { Text("Try again") }
                } else {
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
                    CodeField(StepWords.APPROVAL_CODE_FIELD, answer.typed, answer.completions, enabled = !busy, onType = answer::type, onComplete = answer::complete) { answer.approve() }
                    ApproveButton(busy) { answer.approve() }
                }
                ApprovalAnswer.Phase.CONFIRM -> Box(Modifier.padding(horizontal = AlpineSpace.S6)) { ApproveButton(busy) { answer.approve() } }
                // Approved: the code for the device that asked, until Done. Nothing here ends it or closes it by itself.
                ApprovalAnswer.Phase.SHOWING -> Column(Modifier.padding(horizontal = AlpineSpace.S6), verticalArrangement = Arrangement.spacedBy(AlpineSpace.S4)) {
                    ShownCode(answer.code.orEmpty())
                    Button(onClick = { answer.done() }, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Done") }
                }
            }
            if (answer.error.isNotEmpty()) Text(
                answer.error, color = alpine.danger, style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = AlpineSpace.S6, vertical = AlpineSpace.S2).semantics { liveRegion = LiveRegionMode.Polite },
            )
            // Approved already: there is nothing left to deny.
            if (answer.phase != ApprovalAnswer.Phase.SHOWING) {
                SheetRow("Deny", Icons.Outlined.Block, enabled = !busy) { answer.end(ApprovalAnswering.Ending.DENIED) }
                SheetRow("This wasn’t me", Icons.Outlined.ReportProblem, danger = true, enabled = !busy) { answer.end(ApprovalAnswering.Ending.NOT_ME) }
            }
        }
    }
}

@Composable
private fun ApproveButton(busy: Boolean, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = !busy, modifier = Modifier.fillMaxWidth().padding(top = AlpineSpace.S2).height(48.dp)) { Text("Approve") }
}
