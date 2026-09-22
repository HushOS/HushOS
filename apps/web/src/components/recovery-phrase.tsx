import type { SessionUser } from '@hushos/auth/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { ArrowRightIcon, DownloadIcon, QrCodeIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { AuthLayout } from '@/components/auth-layout';
import { CopyCheckIcon } from '@/components/copy-button';
import { QrCode } from '@/components/qr-code';
import { FormNote, FormTable } from '@/components/form-rows';
import { PendingLabel, TextSwap } from '@/components/motion';
import { returnTarget } from '@/lib/return-to';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { UnlockDevice } from '@/components/unlock-device';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

export type RecoveryReason = 'master-key' | 'recovery-key';

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
    const lockRevision = useStore(authClient.store, (state) => state.lockRevision);
    // The phrase is a query: one attempt per account, credential and lock, asked
    // again after an unlock rather than counted, and never kept once this view is
    // gone. A lock changes the key, so the phrase and the checkbox go with it.
    const backupKey = ['auth', 'recovery-backup', user.id, user.credentialVersion, lockRevision];
    const backupQuery = useQuery({
        queryKey: backupKey,
        queryFn: () =>
            authClient
                .restore(user, { validated: true })
                .then(() => authClient.recoveryBackup(user)),
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });
    const backup = backupQuery.data ?? null;
    const loadError = backupQuery.error ? authError(backupQuery.error) : '';
    const [error, setError] = useState('');
    const [savedAt, setSavedAt] = useState<number | null>(null);
    const saved = savedAt === lockRevision;
    const [copied, setCopied] = useState(false);
    const [pending, setPending] = useState(false);
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
        // Numbered, four to a line: easier to check against a handwritten copy, and the order is part of the phrase.
        const words = backup.phrase.trim().split(/\s+/);
        const numbered = words.map((word, index) =>
            `${String(index + 1).padStart(2, ' ')}. ${word}`.padEnd(16, ' '),
        );
        const lines: string[] = [];
        for (let i = 0; i < numbered.length; i += 4)
            lines.push(
                numbered
                    .slice(i, i + 4)
                    .join('')
                    .trimEnd(),
            );
        const content = [
            'HushOS recovery kit',
            `Saved ${new Date().toISOString().slice(0, 10)}`,
            '',
            'Keep this file private, and keep it somewhere you will find it again.',
            'Anyone who has it can get into your account. If you lose it and forget',
            'your password, nobody can get you back in, including HushOS.',
            '',
            'YOUR ACCOUNT',
            `Email:       ${user.email}`,
            `Account ID:  ${user.id}`,
            '',
            `YOUR RECOVERY PHRASE (${words.length} words, in this order)`,
            'This is what unlocks your account if you forget your password.',
            '',
            ...lines,
            '',
            'The same phrase on one line, for pasting:',
            backup.phrase,
            '',
            'HOW TO USE IT',
            '1. Open HushOS and choose "Forgot your password?".',
            '2. Confirm your email with the link we send.',
            `3. Enter the ${words.length} words above, in order, and choose a new password.`,
            '',
            'WHEN THIS KIT STOPS WORKING',
            'Resetting your password with this phrase, or replacing your recovery',
            'phrase or master key in Settings, makes a new phrase. Save a new kit then.',
            'Changing your password in Settings keeps this phrase as it is.',
            '',
            'FOR RECOVERY TOOLS',
            'The block below is your account key, locked with the phrase above. You do',
            'not need it to reset your password in HushOS. It is here so the phrase can',
            'open your key even without the service.',
            '',
            JSON.stringify(backup.recovery, null, 4),
        ].join('\n');
        const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'hushos-recovery-kit.txt';
        anchor.click();
        URL.revokeObjectURL(url);
        setError('');
        cue('success', { volume: 0.4 });
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
    return (
        <AuthLayout
            embedded
            title={confirmed ? 'Your recovery phrase' : 'Save your recovery phrase'}
            stamp={confirmed ? 'Saved' : reason ? 'New phrase' : 'One-time setup'}
            description={`${
                reason === 'master-key'
                    ? 'Your master key was rotated and your previous phrase no longer works. '
                    : reason === 'recovery-key'
                      ? 'Your previous phrase no longer works. '
                      : ''
            }These 24 words, with access to your email, are the only way to set a new password if you forget yours. Store them somewhere private and offline.`}
        >
            {ready ? (
                <div className="flex flex-col gap-4">
                    {error && (
                        <p
                            role="alert"
                            className="rounded-md bg-destructive-soft px-4 py-3 text-sm leading-relaxed text-destructive"
                        >
                            {error}
                        </p>
                    )}
                    <ol
                        aria-label="Recovery phrase"
                        className="grid grid-cols-2 overflow-hidden rounded-md border border-rule bg-muted font-mono text-sm sm:grid-cols-3 md:grid-cols-4"
                    >
                        {backup.phrase.split(' ').map((word, index) => (
                            <li
                                key={`${index}-${word}`}
                                className="flex items-baseline gap-3 border-r border-b border-rule px-3.5 py-3 animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards duration-300 ease-out-expo nth-[2n]:border-r-0 sm:nth-[2n]:border-r sm:nth-[3n]:border-r-0 md:nth-[3n]:border-r md:nth-[4n]:border-r-0 [&:nth-last-child(-n+2)]:border-b-0 sm:[&:nth-last-child(-n+3)]:border-b-0 md:[&:nth-last-child(-n+4)]:border-b-0"
                                style={{ animationDelay: `${index * 25}ms` }}
                            >
                                <span className="w-5 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
                                    {index + 1}
                                </span>
                                <span className="font-medium">{word}</span>
                            </li>
                        ))}
                    </ol>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={() => void copy()}>
                            <TextSwap>{copied ? 'Copied' : 'Copy phrase'}</TextSwap>
                            <CopyCheckIcon done={copied} className="size-4" />
                        </Button>
                        <Button variant="outline" onClick={download}>
                            Download kit <DownloadIcon aria-hidden="true" />
                        </Button>
                    </div>
                    <details className="group overflow-hidden rounded-md border border-rule">
                        <summary className="flex h-11 cursor-pointer items-center justify-between px-4 text-sm font-semibold text-foreground select-none hover:bg-muted">
                            Show as QR code
                            <QrCodeIcon className="size-4 text-primary" aria-hidden="true" />
                        </summary>
                        <div className="border-t border-rule p-5">
                            <div className="mx-auto w-fit rounded-xs border border-rule bg-white p-3">
                                <QrCode
                                    value={backup.phrase}
                                    kind="recovery"
                                    title="Private recovery phrase"
                                />
                            </div>
                            <p className="mx-auto mt-4 w-fit rounded-md bg-warning-soft px-3 py-2 text-center text-xs leading-relaxed text-warning">
                                Scan only into something you control. This is your phrase in plain
                                text.
                            </p>
                        </div>
                    </details>
                    {!confirmed || setup ? (
                        <>
                            {!confirmed && (
                                <label
                                    htmlFor="saved"
                                    className="flex cursor-pointer items-start gap-3 rounded-md bg-warning-soft px-4 py-3.5 text-sm leading-snug"
                                >
                                    <Checkbox
                                        id="saved"
                                        checked={saved}
                                        onCheckedChange={(value) =>
                                            setSavedAt(value === true ? lockRevision : null)
                                        }
                                        className="mt-0.5"
                                    />
                                    <span>
                                        I’ve saved my recovery phrase somewhere private. I
                                        understand HushOS can’t recover it for me.
                                    </span>
                                </label>
                            )}
                            <div className="flex">
                                <Button
                                    size="lg"
                                    className="flex-1 justify-between"
                                    disabled={(!confirmed && !saved) || pending}
                                    onClick={() => void finish()}
                                >
                                    <PendingLabel
                                        pending={pending}
                                        idle="Continue to HushOS"
                                        busy="Continuing…"
                                    />
                                    <ArrowRightIcon aria-hidden="true" />
                                </Button>
                            </div>
                        </>
                    ) : null}
                </div>
            ) : (
                <FormTable>
                    {!backup && (error || loadError) && unlockedUserId !== user.id ? (
                        <>
                            <FormNote>Unlock this device to view your recovery phrase.</FormNote>
                            <UnlockDevice
                                user={user}
                                onUnlocked={() => {
                                    setError('');
                                    void backupQuery.refetch();
                                }}
                            />
                        </>
                    ) : error || loadError ? (
                        <FormNote tone="destructive">{error || loadError}</FormNote>
                    ) : (
                        <FormNote>Opening your recovery phrase…</FormNote>
                    )}
                </FormTable>
            )}
        </AuthLayout>
    );
}
