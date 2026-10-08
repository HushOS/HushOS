import type { SessionUser } from '@hushos/auth/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { cn } from 'cn';
import { CopyIcon, DownloadIcon, PrinterIcon } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import { AuthLayout, AuthNote } from '@/components/auth-layout';
import { LogoBadge } from '@/components/brand';
import { QrCode } from '@/components/qr-code';
import { Spinner } from '@/components/motion';
import { returnTarget } from '@/lib/return-to';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { UnlockDevice } from '@/components/unlock-device';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { checkQuestions, kitText } from '@/lib/recovery-kit';
import { cue } from '@/lib/sounds';

export type RecoveryReason = 'master-key' | 'recovery-key';

/*
 * The phrase is a query: one attempt per account, credential and lock, asked
 * again after an unlock rather than counted, and never kept once the view
 * showing it is gone. A lock changes the key, so the phrase goes with it.
 */
export function useRecoveryBackup(user: SessionUser) {
    const lockRevision = useStore(authClient.store, (state) => state.lockRevision);
    const unlockedUserId = useStore(authClient.store, (state) => state.unlockedUserId);
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

type Backup = NonNullable<ReturnType<typeof useRecoveryBackup>['backup']>;

/* The kit as a text file, downloaded. */
export function downloadKit(user: SessionUser, backup: Backup) {
    const content = kitText({ email: user.email, id: user.id }, backup.phrase, backup.recovery);
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'hushos-recovery-kit.txt';
    anchor.click();
    URL.revokeObjectURL(url);
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
    const unlockedUserId = useStore(authClient.store, (state) => state.unlockedUserId);
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
    const [copied, setCopied] = useState(false);
    const [pending, setPending] = useState(false);
    /* After the kit, three words picked back out of it, before the first save is confirmed. */
    const [checking, setChecking] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 2_000);
        return () => window.clearTimeout(timer);
    }, [copied]);
    async function copy() {
        if (!backup) return;
        setError('');
        try {
            await navigator.clipboard.writeText(backup.phrase);
            cue('success', { volume: 0.4 });
            setCopied(true);
        } catch {
            cue('error');
            setError('Copying isn’t available here. Download the kit instead.');
        }
    }
    function download() {
        if (!backup) return;
        downloadKit(user, backup);
        setError('');
    }
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
            description="These 24 words get you back in if you forget your password. HushOS can’t recover them for you."
        >
            {ready ? (
                <div className="flex flex-col gap-5">
                    {fresh && (
                        <AuthNote tone="info">
                            {reason === 'master-key'
                                ? 'Your sharing keys are reset, and your old phrase no longer works. Save these 24 words instead.'
                                : 'Your old phrase no longer works. Save these 24 words before you leave this page.'}
                        </AuthNote>
                    )}
                    {error && <AuthNote tone="danger">{error}</AuthNote>}
                    <PhraseGrid phrase={backup.phrase} />
                    <KitSheet email={user.email} phrase={backup.phrase} />
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={download}>
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
                    </div>
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
                                        className="mt-0.5"
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
            className="hidden flex-col gap-7 font-sans text-[#141a33] [print-color-adjust:exact] print:flex"
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
                <div className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-[#4a5375]">Account</span>
                    <span className="text-base font-semibold">{email}</span>
                </div>
                {/* The same 24 words, for the HushOS apps to scan when you recover there. */}
                <div className="flex shrink-0 flex-col items-center gap-1">
                    <QrCode value={phrase} size={112} title="Recovery phrase" />
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
        <AuthLayout title="Check you saved it" description="Pick the missing words from your kit.">
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
                                        'h-9 min-w-0 flex-1 cursor-pointer rounded-sm font-mono text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring',
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
