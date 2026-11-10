import type { SessionUser } from '@hushos/auth/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { cn } from 'cn';
import { CopyIcon, DownloadIcon, PrinterIcon, QrCodeIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AuthLayout, AuthNote } from '@/components/auth-layout';
import { LogoBadge } from '@/components/brand';
import { Cover } from '@/components/cover';
import { QrCode } from '@/components/qr-code';
import { Spinner } from '@/components/motion';
import { returnTarget } from '@/lib/return-to';
import { saveBlob } from '@/lib/save-file';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { UnlockDevice } from '@/components/unlock-device';
import { authClient } from '@/lib/auth-client';
import { useAuthView } from '@/lib/auth-view';
import { authError } from '@/lib/form';
import { checkQuestions, kitText } from '@/lib/recovery-kit';
import { cue } from '@/lib/sounds';
import { copySecret } from '@/lib/clipboard';

export type RecoveryReason = 'master-key' | 'recovery-key';

/*
 * The phrase is a query: one attempt per account, credential and lock, asked
 * again after an unlock rather than counted, and never kept once the view
 * showing it is gone. A lock changes the key, so the phrase goes with it.
 */
export function useRecoveryBackup(user: SessionUser) {
    const lockRevision = useAuthView((state) => state.lockRevision);
    const unlockedUserId = useAuthView((state) => state.unlockedUserId);
    const key = ['auth', 'recovery-backup', user.id, user.credentialVersion, lockRevision];
    const query = useQuery({
        queryKey: key,
        queryFn: () =>
            authClient
                .restore(user, { validated: true })
                .then(() => authClient.recoveryBackup(user)),
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });
    return {
        key,
        query,
        lockRevision,
        unlocked: unlockedUserId === user.id,
        backup: query.data ?? null,
        loadError: query.error ? authError(query.error) : '',
    };
}

/* The kit as a text file, downloaded. */
export function downloadKit(
    account: { email: string; id: string },
    backup: { phrase: string; recovery: unknown },
) {
    const content = kitText(
        { email: account.email, id: account.id },
        backup.phrase,
        backup.recovery,
    );
    saveBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), 'hushos-recovery-kit.txt');
    cue('success', { volume: 0.4 });
}

/* The 24 words, numbered, in the order they must be typed. */
export function PhraseGrid({ phrase }: { phrase: string }) {
    return (
        <ol
            aria-label="Recovery phrase"
            className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 print:grid-cols-4"
        >
            {phrase.split(' ').map((word, index) => (
                <li
                    key={`${index}-${word}`}
                    className="flex items-baseline gap-2 rounded-md bg-muted px-3 py-2.5 animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards duration-300 ease-out-expo print:border print:border-rule print:bg-transparent"
                    style={{ animationDelay: `${index * 20}ms` }}
                >
                    <span className="w-5 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                        {index + 1}
                    </span>
                    <span className="font-mono text-[15px] font-medium">{word}</span>
                </li>
            ))}
        </ol>
    );
}

/*
 * The words and every way to keep them: the grid, the kit as a file or on paper, a copy, and
 * the code the phone app scans. `onError` is handed what could not be done here, and '' once
 * something could.
 */
export function PhraseKit({
    account,
    phrase,
    recovery,
    onError,
}: {
    account: { email: string; id: string };
    phrase: string;
    recovery: unknown;
    onError: (message: string) => void;
}) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 2_000);
        return () => window.clearTimeout(timer);
    }, [copied]);
    async function copy() {
        onError('');
        try {
            await copySecret(phrase);
            cue('success', { volume: 0.4 });
            setCopied(true);
        } catch {
            cue('error');
            onError('Copying isn’t available here. Download the kit instead.');
        }
    }
    return (
        <>
            <PhraseGrid phrase={phrase} />
            <KitSheet email={account.email} phrase={phrase} />
            <PhraseQr phrase={phrase}>
                <Button
                    variant="outline"
                    onClick={() => {
                        downloadKit(account, { phrase, recovery });
                        onError('');
                    }}
                >
                    <DownloadIcon />
                    Download kit
                </Button>
                <Button variant="outline" onClick={() => window.print()}>
                    <PrinterIcon />
                    Print
                </Button>
                <Button variant="ghost" onClick={() => void copy()}>
                    <CopyIcon />
                    {copied ? 'Copied' : 'Copy words'}
                </Button>
            </PhraseQr>
        </>
    );
}

export function RecoveryPhrase({
    user,
    setup = false,
    reason,
}: {
    user: SessionUser;
    setup?: boolean;
    reason?: RecoveryReason;
}) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const unlockedUserId = useAuthView((state) => state.unlockedUserId);
    const {
        key: backupKey,
        query: backupQuery,
        lockRevision,
        backup,
        loadError,
    } = useRecoveryBackup(user);
    const [error, setError] = useState('');
    const [savedAt, setSavedAt] = useState<number | null>(null);
    const saved = savedAt === lockRevision;
    const [pending, setPending] = useState(false);
    /* After the kit, three words picked back out of it, before the first save is confirmed. */
    const [checking, setChecking] = useState(false);
    async function finish() {
        if (!backup || (!backup.confirmed && !saved)) return;
        setPending(true);
        setError('');
        try {
            if (!backup.confirmed)
                await authClient.confirmRecoveryBackup(backup.recovery.recoveryVersion);
            queryClient.removeQueries({ queryKey: backupKey });
            cue('ready');
            // A sign-up or sign-in that started on a link or an app page goes back there now.
            await router.navigate({ href: returnTarget(), replace: true });
        } catch (error) {
            cue('error');
            setError(authError(error));
        } finally {
            setPending(false);
        }
    }
    const ready = backup && unlockedUserId === user.id;
    const confirmed = backup?.confirmed ?? false;
    const fresh = reason === 'master-key' || reason === 'recovery-key';
    if (checking && ready)
        return (
            <CheckWords
                phrase={backup.phrase}
                pending={pending}
                error={error}
                onBack={() => setChecking(false)}
                onDone={() => void finish()}
            />
        );
    return (
        <AuthLayout
            wide
            title={fresh ? 'Your new recovery phrase' : 'Save your recovery kit'}
            art="24"
            description="These 24 words get you back in if you forget your password. HushOS can’t recover them for you."
        >
            {ready ? (
                <div className="flex flex-col gap-5">
                    {fresh && (
                        <AuthNote tone="info">
                            {reason === 'master-key'
                                ? 'Your account key is rotated, and your old phrase no longer works. Save these 24 words instead.'
                                : 'Your old phrase no longer works. Save these 24 words before you leave this page.'}
                        </AuthNote>
                    )}
                    {error && <AuthNote tone="danger">{error}</AuthNote>}
                    <PhraseKit
                        account={user}
                        phrase={backup.phrase}
                        recovery={backup.recovery}
                        onError={setError}
                    />
                    {!confirmed || setup ? (
                        <>
                            {!confirmed && (
                                <label
                                    htmlFor="saved"
                                    className="flex cursor-pointer items-start gap-2.5 border-t border-rule pt-4 text-sm leading-snug"
                                >
                                    <Checkbox
                                        id="saved"
                                        checked={saved}
                                        onCheckedChange={(value) =>
                                            setSavedAt(value === true ? lockRevision : null)
                                        }
                                        className="mt-px"
                                    />
                                    I’ve saved my kit or written the words down, somewhere private.
                                </label>
                            )}
                            <div className="flex justify-end">
                                <Button
                                    size="lg"
                                    className="max-sm:w-full"
                                    disabled={(!confirmed && !saved) || pending}
                                    onClick={() => (confirmed ? void finish() : setChecking(true))}
                                >
                                    {pending ? 'Opening HushOS…' : 'Continue'}
                                </Button>
                            </div>
                        </>
                    ) : null}
                </div>
            ) : !backup && (error || loadError) && unlockedUserId !== user.id ? (
                <div className="flex flex-col gap-3">
                    <p className="text-sm font-semibold">Unlock to see your recovery phrase.</p>
                    <UnlockDevice
                        user={user}
                        onUnlocked={() => {
                            setError('');
                            void backupQuery.refetch();
                        }}
                    />
                </div>
            ) : error || loadError ? (
                <AuthNote tone="danger">{error || loadError}</AuthNote>
            ) : (
                <output className="flex items-center gap-2.5 text-sm text-muted-foreground">
                    <Spinner />
                    Opening your recovery phrase
                </output>
            )}
        </AuthLayout>
    );
}

/*
 * A new phrase from a change whose reply never arrived (docs/two-step-design.md 4, "When the
 * reply is lost"): made on this device and shown before the person signs in again, since the
 * second step of that sign-in may ask for it. Whether the server made the change is not known
 * here, so the page says both: this phrase if it did, the old one if it did not. Saved and
 * checked as any new phrase is; nothing is confirmed to the server, there being no session to
 * confirm it in.
 */
export function LostReplyPhrase({
    account,
    phrase,
    recovery,
    onDone,
}: {
    account: { email: string; id: string };
    phrase: string;
    recovery: unknown;
    onDone: () => void;
}) {
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    const [checking, setChecking] = useState(false);
    if (checking)
        return (
            <CheckWords
                phrase={phrase}
                pending={false}
                error=""
                onBack={() => setChecking(false)}
                onDone={onDone}
            />
        );
    return (
        <AuthLayout
            wide
            title="Save your new recovery phrase"
            art="24"
            description="We lost the connection while making this change. If it went through, this is your new recovery phrase. Save it, then sign in."
        >
            <div className="flex flex-col gap-5">
                <AuthNote tone="info">
                    If it didn’t go through, your old phrase still works, so keep that one too.
                    After you sign in, the Recovery phrase page shows which one is yours now.
                </AuthNote>
                {error && <AuthNote tone="danger">{error}</AuthNote>}
                <PhraseKit
                    account={account}
                    phrase={phrase}
                    recovery={recovery}
                    onError={setError}
                />
                <label
                    htmlFor="saved"
                    className="flex cursor-pointer items-start gap-2.5 border-t border-rule pt-4 text-sm leading-snug"
                >
                    <Checkbox
                        id="saved"
                        checked={saved}
                        onCheckedChange={(value) => setSaved(value === true)}
                        className="mt-px"
                    />
                    I’ve saved my kit or written the words down, somewhere private.
                </label>
                <div className="flex justify-end">
                    <Button
                        size="lg"
                        className="max-sm:w-full"
                        disabled={!saved}
                        onClick={() => setChecking(true)}
                    >
                        Continue
                    </Button>
                </div>
            </div>
        </AuthLayout>
    );
}

/*
 * The kit's code on screen, for recovering in the phone app straight from this
 * page. Hidden until asked for: the code is the 24 words, readable by any camera
 * that sees it. Square modules, as on paper; it is the one code that has to scan.
 */
export function PhraseQr({ phrase, children }: { phrase: string; children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const panel = useId();
    // Hidden again when the tab is, so a tab left open never shows it in a later screen share.
    useEffect(() => {
        if (!open) return;
        const hide = () => {
            if (document.visibilityState === 'hidden') setOpen(false);
        };
        document.addEventListener('visibilitychange', hide);
        return () => document.removeEventListener('visibilitychange', hide);
    }, [open]);
    // The kit's other actions come first, in one row with this toggle; the code opens under them.
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
                {children}
                <Button
                    variant="ghost"
                    aria-expanded={open}
                    aria-controls={panel}
                    onClick={() => setOpen((value) => !value)}
                >
                    <QrCodeIcon />
                    {open ? 'Hide QR code' : 'Show QR code'}
                </Button>
            </div>
            {open && (
                <div
                    id={panel}
                    className="flex w-fit flex-col items-center gap-2 rounded-xl bg-muted p-4"
                >
                    {/* White under the code in either theme, so a camera reads it. */}
                    <div className="rounded-md bg-white p-2">
                        {/* Three whole pixels a module (about 200 to 240px for 24 words), so a phone camera reads it off a screen. */}
                        <QrCode value={phrase} cell={3} title="Recovery phrase" kind="recovery" />
                    </div>
                    <p className="max-w-[20rem] text-center text-[13px] text-muted-foreground">
                        To recover in the HushOS app, scan this when it asks for your kit. Like the
                        words, it opens your account for anyone who can also get into your email.
                    </p>
                </div>
            )}
        </div>
    );
}

/*
 * The kit on paper: shown only when printing, the same one page from every
 * page that offers Print. The words, the account, and what to do with it.
 */
const noSubscription = () => () => {};

/*
 * The printed kit. It goes straight into the body, so it prints across the
 * whole page whatever the screen layout around it, with its own margins so
 * "Margins: None" still leaves room. Paper is white whatever the theme, so it
 * is drawn in Hush blue, not the theme's colours.
 */
export function KitSheet({ email, phrase }: { email: string; phrase: string }) {
    const [madeOn] = useState(() =>
        new Date().toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        }),
    );
    // The server has no body to put it in; the browser does once it hydrates.
    const mounted = useSyncExternalStore(
        noSubscription,
        () => true,
        () => false,
    );
    if (!mounted) return null;
    return createPortal(
        <div
            data-print
            className="hidden flex-col gap-6 font-sans text-[#141a33] [print-color-adjust:exact] print:flex"
        >
            <div className="flex items-center justify-between border-b-2 border-[#2c428e] pb-4">
                <div className="flex items-center gap-3">
                    <LogoBadge className="size-10" />
                    <span className="flex flex-col">
                        <span className="text-lg leading-tight font-bold text-[#2c428e]">
                            HushOS
                        </span>
                        <span className="text-[13px] leading-tight">Recovery kit</span>
                    </span>
                </div>
                <span className="text-xs text-[#4a5375]">Made {madeOn}</span>
            </div>
            <div className="flex items-end justify-between gap-6">
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                    {/*
                     * Dither (DESIGN.md): the kit's word in blue dots on the paper, a wash at
                     * its foot, in the room beside the code, so the kit stays one page on A4
                     * and US Letter with a print dialog's own margins.
                     */}
                    <Cover
                        word="RECOVERY"
                        tone="paper"
                        seed="recovery-kit"
                        cols={104}
                        rows={20}
                        dither
                    />
                    <div className="flex flex-col gap-1">
                        <span className="text-[13px] text-[#4a5375]">Account</span>
                        <span className="text-base font-semibold">{email}</span>
                    </div>
                </div>
                {/* The same 24 words, for the HushOS apps to scan when you recover there. */}
                <div className="flex shrink-0 flex-col items-center gap-1">
                    <QrCode value={phrase} size={128} title="Recovery phrase" kind="recovery" />
                    <span className="text-[11px] text-[#4a5375]">Scan in the HushOS app</span>
                </div>
            </div>
            <ol className="grid grid-cols-3 gap-2.5">
                {phrase.split(' ').map((word, index) => (
                    <li
                        key={`${index}-${word}`}
                        className="flex items-baseline gap-2.5 rounded-md bg-[#eef1fb] px-3 py-2.5"
                    >
                        <span className="w-5 text-right text-xs font-semibold text-[#2c428e] tabular-nums">
                            {index + 1}
                        </span>
                        <span className="font-mono text-base">{word}</span>
                    </li>
                ))}
            </ol>
            <div className="flex flex-col gap-2 border-l-[3px] border-[#2c428e] pl-4 text-[13px] leading-snug">
                <span className="font-semibold text-[#2c428e]">If you forget your password</span>
                <span>
                    Choose “Forgot your password?” when you sign in to HushOS, on the web or in the
                    app, and confirm your email. Then type these 24 words in order, or scan the code
                    above in the app. You’ll get a new phrase afterwards; this page then stops
                    working.
                </span>
                <span className="pt-1 font-semibold text-[#2c428e]">Keep it private</span>
                <span>
                    Anyone with these words and access to your email can open your account. HushOS
                    can’t recover them for you.
                </span>
            </div>
        </div>,
        document.body,
    );
}

/* Three words picked back out of the kit; Finish waits until all three are right. */
function CheckWords({
    phrase,
    pending,
    error,
    onBack,
    onDone,
}: {
    phrase: string;
    pending: boolean;
    error: string;
    onBack: () => void;
    onDone: () => void;
}) {
    const words = phrase.split(' ');
    const [questions] = useState(() => checkQuestions(words));
    const [picks, setPicks] = useState<Record<number, string>>({});
    const right = (position: number) => picks[position] === words[position - 1];
    const done = questions.every((question) => right(question.position));
    return (
        <AuthLayout
            art="CHECK"
            title="Check you saved it"
            description="Pick the missing words from your kit."
        >
            {error && <AuthNote tone="danger">{error}</AuthNote>}
            {questions.map((question) => {
                const pick = picks[question.position];
                const wrong = pick !== undefined && !right(question.position);
                return (
                    <fieldset
                        key={question.position}
                        className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
                    >
                        <legend className="mb-1.5 text-[13px] font-semibold">
                            Word {question.position}
                        </legend>
                        <div className="flex gap-1 rounded-md bg-muted p-1">
                            {question.options.map((word) => (
                                <button
                                    key={word}
                                    type="button"
                                    aria-pressed={pick === word}
                                    onClick={() =>
                                        setPicks((current) => ({
                                            ...current,
                                            [question.position]: word,
                                        }))
                                    }
                                    className={cn(
                                        'h-9 min-w-0 flex-1 cursor-pointer rounded-sm font-mono text-sm outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
                                        pick === word &&
                                            !wrong &&
                                            'bg-card font-semibold text-primary shadow-sm ring-1 ring-primary',
                                        pick === word &&
                                            wrong &&
                                            'bg-destructive-soft font-semibold text-destructive ring-1 ring-destructive',
                                    )}
                                >
                                    {word}
                                </button>
                            ))}
                        </div>
                        {wrong && (
                            <p role="alert" className="text-[13px] text-destructive">
                                That isn’t word {question.position}. Look at your kit again.
                            </p>
                        )}
                    </fieldset>
                );
            })}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <button
                    type="button"
                    onClick={onBack}
                    className="cursor-pointer text-sm font-semibold underline underline-offset-4"
                >
                    Show my words again
                </button>
                <Button size="lg" disabled={!done || pending} onClick={onDone}>
                    {pending ? 'Opening HushOS…' : 'Finish'}
                </Button>
            </div>
        </AuthLayout>
    );
}
