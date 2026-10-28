import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { firstName } from '@/components/drive/add-someone';
import { Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { continueWith, lookupContact, TrustMovedError, type AccountChange } from '@/lib/contacts';
import { driveClient, driveError, driveKeys } from '@/lib/drive';
import { afterTrustChanged } from '@/lib/integrity';
import { cue } from '@/lib/sounds';

/*
 * "Maya's account changed" (docs/optional-verification.md 6.7): the one calm
 * notice for keys that changed with no signed chain from the ones this device
 * holds, wherever it is met (Contacts, the share sheet, something they
 * shared). Until Continue or a check, nothing new is shared with them,
 * nothing is sealed to them again and nothing they shared opens, what they
 * shared before included; links never pause. Continue
 * takes the keys HushOS serves now, and what waited runs: everything shared
 * with them is sealed again, to the new keys only. For someone this device had
 * checked, the check leads. A step of the contact flow (contact-flow.tsx):
 * it fills the dialog it is met in, and Check it's Maya replaces it there.
 */
export function AccountChangedStep({
    userId,
    change,
    onDone,
    onCheck,
    onResolved,
}: {
    userId: string;
    change: AccountChange;
    onDone: () => void;
    /* Check it's Maya, which replaces this notice in the same dialog. */
    onCheck: () => void;
    /* Continue went through: what waited on them may run now (the share sheet's interrupted share). */
    onResolved?: () => void;
}) {
    const queryClient = useQueryClient();
    const name = firstName(change.name);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    // What this device held and what is served now, for the variant and Technical details.
    const found = useQuery({
        queryKey: ['contacts', 'changed', userId, change.contactId],
        queryFn: () => lookupContact(queryClient, userId, change.email),
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });
    const lookup = found.data;

    async function proceed() {
        setBusy(true);
        setError('');
        try {
            await continueWith(queryClient, userId, change);
            afterTrustChanged(queryClient);
            void queryClient.invalidateQueries({ queryKey: driveKeys.shared });
            // What was shared with them is sealed again, to these keys.
            void driveClient.upgradeShares().catch(() => {});
            cue('success');
            toast.add({ type: 'success', title: `You’re sharing with ${name} again` });
            onResolved?.();
            onDone();
        } catch (cause) {
            cue('error');
            setError(driveError(cause));
            // Another device moved them meanwhile: where they stand now is looked up again.
            if (cause instanceof TrustMovedError) void found.refetch();
        } finally {
            setBusy(false);
        }
    }

    // A lookup that finds nothing changed after all (a signed chain followed, keys back as they
    // were) leaves nothing to decide.
    const settled = lookup !== undefined && !lookup.changed;
    const checkFirst = lookup?.wasVerified ?? false;
    const continueButton = (
        <Button
            key="continue"
            variant={checkFirst ? 'outline' : 'default'}
            disabled={busy || !lookup?.changed}
            onClick={() => void proceed()}
        >
            {busy ? 'Continuing…' : 'Continue'}
        </Button>
    );
    const checkButton = (
        <Button
            key="check"
            variant={checkFirst ? 'default' : 'outline'}
            disabled={busy || !lookup?.changed || !lookup.upgraded}
            onClick={onCheck}
        >
            Check it’s {name}
        </Button>
    );
    return (
        <>
            <DialogHeader>
                <DialogTitle>{name}’s account changed</DialogTitle>
                <DialogDescription>
                    This happens when someone starts their HushOS account over, for example after
                    losing their phone.
                </DialogDescription>
            </DialogHeader>
            {found.isPending && (
                <output className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="size-4" />
                    Checking
                </output>
            )}
            {found.isError && (
                <div className="flex flex-col items-start gap-3">
                    <p role="alert" className="text-sm text-destructive">
                        {driveError(found.error)}
                    </p>
                    <Button variant="outline" onClick={() => void found.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </div>
            )}
            {settled && (
                <p className="text-sm text-muted-foreground">
                    Nothing needs doing: you can share with {name} as before.
                </p>
            )}
            {lookup?.changed && (
                <>
                    <p className="text-sm">
                        {checkFirst
                            ? `You’d checked it was ${name} before. You may want to check again.`
                            : `You can keep sharing with ${name} as before.`}
                    </p>
                    <details className="group">
                        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[13px] font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                            Technical details
                            <ChevronDownIcon
                                aria-hidden="true"
                                className="size-3.5 transition-transform group-open:rotate-180"
                            />
                        </summary>
                        <p className="mt-2 text-[13px] text-muted-foreground">
                            {name}’s keys are different from the ones your device remembered, and
                            their previous keys didn’t sign the change.
                        </p>
                        <dl className="mt-2 flex flex-col gap-2 text-[13px]">
                            <div>
                                <dt className="text-muted-foreground">Remembered</dt>
                                <dd className="font-mono wrap-anywhere">
                                    {lookup.heldFingerprint ?? 'None'}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Now</dt>
                                <dd className="font-mono wrap-anywhere">
                                    {lookup.fingerprint ?? 'None'}
                                </dd>
                            </div>
                        </dl>
                    </details>
                </>
            )}
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
            <DialogFooter>
                {settled ? (
                    <Button onClick={onDone}>Done</Button>
                ) : (
                    // The second choice first, so the blue one sits last, where every dialog has it.
                    <>
                        {checkFirst ? [continueButton, checkButton] : [checkButton, continueButton]}
                    </>
                )}
            </DialogFooter>
        </>
    );
}
