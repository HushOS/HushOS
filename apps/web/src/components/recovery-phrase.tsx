import type { SessionUser } from '@hushos/auth/protocol';
import { useRouter } from '@tanstack/react-router';
import { ArrowRightIcon, DownloadIcon, QrCodeIcon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { AuthLayout } from '@/components/auth-layout';
import { CopyCheckIcon } from '@/components/copy-button';
import { FormNote, FormTable } from '@/components/form-rows';
import { PendingLabel, TextSwap } from '@/components/motion';
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
    const unlockedUserId = useStore(authClient.store, (state) => state.unlockedUserId);
    const [backup, setBackup] = useState<Awaited<
        ReturnType<typeof authClient.recoveryBackup>
    > | null>(null);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    const [copied, setCopied] = useState(false);
    const [pending, setPending] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let active = true;
        void authClient
            .restore(user, { validated: true })
            .then(() => authClient.recoveryBackup(user))
            .then((value) => {
                if (active) setBackup(value);
            })
            .catch((error) => {
                if (active) setError(authError(error));
            });
        return () => {
            active = false;
        };
    }, [user, attempt]);
    useEffect(
        () =>
            authClient.store.subscribe((state) => {
                if (state.unlockedUserId !== user.id) {
                    setBackup(null);
                    setSaved(false);
                }
            }),
        [user.id],
    );
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
        const content = [
            'HushOS recovery kit',
            '',
            'Keep this file private. Anyone with this phrase and the encrypted account-key bundle can unlock that key.',
            '',
            `Account: ${user.email}`,
            `Account ID: ${user.id}`,
            '',
            backup.phrase,
            '',
            'Encrypted recovery bundle (versioned JSON):',
            JSON.stringify(backup.recovery, null, 4),
            '',
            'To reset your password, open HushOS, choose Forgot your password, verify your email, and enter the 24 words.',
            'Password recovery and either recovery-key or master-key rotation replace this phrase. Save a new kit afterward.',
            'Changing your password from Account settings preserves this phrase.',
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
            setBackup(null);
            cue('ready');
            await router.navigate({ to: '/app', replace: true });
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
                <div className="border bg-card">
                    {error && (
                        <div className="border-b">
                            <FormNote tone="destructive">{error}</FormNote>
                        </div>
                    )}
                    <ol
                        aria-label="Recovery phrase"
                        className="grid grid-cols-2 border-b font-mono text-sm sm:grid-cols-3 md:grid-cols-4"
                    >
                        {backup.phrase.split(' ').map((word, index) => (
                            <li
                                key={`${index}-${word}`}
                                className="flex items-baseline gap-3 border-r border-b px-3.5 py-3 animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards duration-300 ease-out-expo nth-[2n]:border-r-0 sm:nth-[2n]:border-r sm:nth-[3n]:border-r-0 md:nth-[3n]:border-r md:nth-[4n]:border-r-0 [&:nth-last-child(-n+2)]:border-b-0 sm:[&:nth-last-child(-n+3)]:border-b-0 md:[&:nth-last-child(-n+4)]:border-b-0"
                                style={{ animationDelay: `${index * 25}ms` }}
                            >
                                <span className="w-5 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
                                    {index + 1}
                                </span>
                                <span className="font-medium">{word}</span>
                            </li>
                        ))}
                    </ol>
                    <div className="grid grid-cols-2 border-b">
                        <Button
                            variant="row"
                            size="row"
                            className="h-12 border-r px-4 sm:px-4"
                            onClick={() => void copy()}
                        >
                            <TextSwap>{copied ? 'Copied' : 'Copy phrase'}</TextSwap>
                            <CopyCheckIcon done={copied} className="size-4" />
                        </Button>
                        <Button
                            variant="row"
                            size="row"
                            className="h-12 px-4 sm:px-4"
                            onClick={download}
                        >
                            Download kit <DownloadIcon aria-hidden="true" />
                        </Button>
                    </div>
                    <details className="group border-b">
                        <summary className="eyebrow flex h-12 cursor-pointer items-center justify-between px-4 text-foreground select-none hover:bg-muted">
                            Show as QR code
                            <QrCodeIcon className="size-4 text-primary" aria-hidden="true" />
                        </summary>
                        <div className="border-t p-5">
                            <div className="mx-auto w-fit border bg-white p-3">
                                <QRCodeSVG
                                    value={backup.phrase}
                                    size={176}
                                    marginSize={1}
                                    title="Private recovery phrase"
                                />
                            </div>
                            <p className="mt-4 text-center font-mono text-[11px] text-muted-foreground">
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
                                    className="flex cursor-pointer items-start gap-3 px-4 py-4 text-sm leading-snug"
                                >
                                    <Checkbox
                                        id="saved"
                                        checked={saved}
                                        onCheckedChange={(value) => setSaved(value === true)}
                                        className="mt-0.5"
                                    />
                                    <span>
                                        I’ve saved my recovery phrase somewhere private. I
                                        understand HushOS can’t recover it for me.
                                    </span>
                                </label>
                            )}
                            <div className="flex border-t">
                                <Button
                                    size="lg"
                                    className="h-14 flex-1 justify-between border-0 px-5"
                                    disabled={(!confirmed && !saved) || pending}
                                    onClick={() => void finish()}
                                    data-cuelume-press="pulse"
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
                    {!backup && error && unlockedUserId !== user.id ? (
                        <>
                            <FormNote>Unlock this device to view your recovery phrase.</FormNote>
                            <UnlockDevice
                                user={user}
                                onUnlocked={() => {
                                    setError('');
                                    setAttempt((value) => value + 1);
                                }}
                            />
                        </>
                    ) : error ? (
                        <FormNote tone="destructive">{error}</FormNote>
                    ) : (
                        <FormNote>Opening your recovery phrase…</FormNote>
                    )}
                </FormTable>
            )}
        </AuthLayout>
    );
}
