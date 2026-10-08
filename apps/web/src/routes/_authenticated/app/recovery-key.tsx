import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CopyIcon, DownloadIcon, PrinterIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NewKeyDialog } from '@/components/account-dialogs';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { downloadKit, KitSheet, PhraseGrid, useRecoveryBackup } from '@/components/recovery-phrase';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { UnlockDevice } from '@/components/unlock-device';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/recovery-key')({
    head: () => ({
        meta: [{ title: 'Recovery phrase · HushOS' }, { name: 'referrer', content: 'no-referrer' }],
    }),
    component: RecoveryKeyPage,
});

/*
 * The recovery phrase, to look at again: the 24 words, a kit to download or
 * print, and making a new phrase when the old one may have been seen. Printing
 * prints the words and nothing else on the page.
 */
function RecoveryKeyPage() {
    const { user } = Route.useRouteContext();
    const queryClient = useQueryClient();
    const { key, query, unlocked, backup, loadError } = useRecoveryBackup(user);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState('');
    const [making, setMaking] = useState(false);
    const [saved, setSaved] = useState(false);
    const [confirming, setConfirming] = useState(false);
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
    async function confirm() {
        if (!backup) return;
        setConfirming(true);
        setError('');
        try {
            await authClient.confirmRecoveryBackup(backup.recovery.recoveryVersion);
            cue('ready');
            await queryClient.invalidateQueries({ queryKey: key });
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setConfirming(false);
        }
    }

    return (
        <div className="flex flex-col pb-10">
            <PageHeader title="Recovery phrase" />
            <div className="flex max-w-3xl flex-col gap-5 px-5 sm:px-8">
                <p className="text-[15px] text-muted-foreground">
                    These 24 words get you back in if you forget your password. Keep them somewhere
                    private and offline. HushOS can’t recover them for you.
                </p>
                {backup && unlocked ? (
                    <>
                        <PhraseGrid phrase={backup.phrase} />
                        <KitSheet email={user.email} phrase={backup.phrase} />
                        {error && (
                            <p role="alert" className="text-sm text-destructive">
                                {error}
                            </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                            <Button variant="outline" onClick={() => downloadKit(user, backup)}>
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
                        {!backup.confirmed && (
                            <div className="flex flex-col gap-3 rounded-xl bg-warning-soft px-4 py-3.5">
                                <label
                                    htmlFor="phrase-saved"
                                    className="flex cursor-pointer items-start gap-3 text-sm leading-snug"
                                >
                                    <Checkbox
                                        id="phrase-saved"
                                        checked={saved}
                                        onCheckedChange={(value) => setSaved(value === true)}
                                        className="mt-0.5"
                                    />
                                    I’ve saved my recovery phrase somewhere private. I understand
                                    HushOS can’t recover it for me.
                                </label>
                                <Button
                                    className="w-fit"
                                    disabled={!saved || confirming}
                                    onClick={() => void confirm()}
                                >
                                    {confirming ? 'Saving…' : 'I’ve saved it'}
                                </Button>
                            </div>
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-rule pt-5">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-[15px] font-semibold">
                                    Lost your kit, or think someone saw it?
                                </span>
                                <span className="text-sm text-muted-foreground">
                                    Make a new phrase. The old one stops working.
                                </span>
                            </div>
                            <Button variant="outline" onClick={() => setMaking(true)}>
                                Make a new phrase
                            </Button>
                        </div>
                    </>
                ) : !unlocked && (loadError || !query.isPending) ? (
                    <div className="flex max-w-md flex-col gap-3">
                        <p className="text-sm font-semibold">Unlock to see your recovery phrase.</p>
                        <UnlockDevice user={user} onUnlocked={() => void query.refetch()} />
                    </div>
                ) : loadError ? (
                    <p role="alert" className="text-sm text-destructive">
                        {loadError}
                    </p>
                ) : (
                    <output className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Spinner />
                        Opening your recovery phrase
                    </output>
                )}
            </div>
            <NewKeyDialog
                user={user}
                action="recovery-key"
                open={making}
                onOpenChange={setMaking}
            />
        </div>
    );
}
