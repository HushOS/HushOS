import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { firstName } from '@/components/drive/add-someone';
import { FingerprintWords } from '@/components/fingerprint-words';
import { Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import {
    lookupContact,
    notUpgradedWords,
    pinContact,
    removeContact,
    TrustMovedError,
    type Lookup,
} from '@/lib/contacts';
import { driveClient, driveError, driveKeys, formatDay } from '@/lib/drive';
import { vouchLine } from '@/lib/family-pin';
import { afterTrustChanged } from '@/lib/integrity';
import { cue } from '@/lib/sounds';

/* Who is being checked: from a contact, a share row, a mark or the changed-account notice. */
export type Checking = { email: string; name: string };

/*
 * Check it's Maya (docs/optional-verification.md 6.6), the advanced door: the
 * twelve words over the keys HushOS serves for them now, read against the
 * ones on their own device. They match makes the pin verified (over new keys,
 * it is also a Continue, and what was shared with them is sealed again);
 * They don't match saves nothing, and offers Remove Maya from contacts, so
 * nothing new is shared with those keys; what was already shared is stopped
 * item by item from its share sheet (stopping everything with one person at
 * once is docs/optional-verification.md 8, PR 3b). A step of the contact flow
 * (contact-flow.tsx): "Remove Maya?" replaces it in the same dialog, and
 * Cancel there comes back to it.
 */
export function CheckContactStep({
    userId,
    person,
    onDone,
    onResolved,
}: {
    userId: string;
    person: Checking;
    onDone: () => void;
    /* They match went through: what waited on them may run now. */
    onResolved?: () => void;
}) {
    const queryClient = useQueryClient();
    const found = useQuery({
        queryKey: ['contacts', 'check', userId, person.email],
        queryFn: () => lookupContact(queryClient, userId, person.email),
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });
    /* The words, the words not matching, then (replacing it) Remove Maya? */
    const [stage, setStage] = useState<'words' | 'mismatch' | 'remove'>('words');
    const mismatch = stage !== 'words';
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const name = firstName(found.data?.contact.name ?? person.name);

    async function theyMatch(lookup: Lookup) {
        setSaving(true);
        setError('');
        try {
            const pin = await pinContact(queryClient, userId, lookup);
            // What they wrote now reads as verified, and what waited on them runs.
            afterTrustChanged(queryClient);
            void queryClient.invalidateQueries({ queryKey: driveKeys.shared });
            // What was shared with them waits to be sealed to the keys the pin holds now: over
            // keys that changed (a check is a Continue too, as in account-changed.tsx), and after
            // a signed succession the lookup followed just now. Sealed again to these keys only.
            if (pin.resealShares) void driveClient.upgradeShares().catch(() => {});
            cue('success');
            toast.add({ type: 'success', title: `${name} verified` });
            onResolved?.();
            onDone();
        } catch (cause) {
            cue('error');
            setError(cause instanceof Error ? cause.message : 'That wasn’t saved. Try again.');
            // Another device moved them meanwhile: the words are worked out again.
            if (cause instanceof TrustMovedError) void found.refetch();
        } finally {
            setSaving(false);
        }
    }

    async function remove(contactId: string) {
        setSaving(true);
        setError('');
        try {
            await removeContact(queryClient, userId, contactId);
            // What they wrote no longer reads as theirs.
            afterTrustChanged(queryClient);
            cue('droplet');
            toast.add({ type: 'success', title: `${name} removed` });
            onDone();
        } catch (cause) {
            cue('error');
            setError(cause instanceof Error ? cause.message : 'That wasn’t saved. Try again.');
        } finally {
            setSaving(false);
        }
    }

    const lookup = found.data;
    const replacedAt = lookup?.pinned?.keysReplacedAt ?? null;
    const vouched = lookup?.pinned ? vouchLine(lookup.pinned) : null;

    if (stage === 'remove')
        return (
            <>
                <DialogHeader>
                    <DialogTitle>Remove {name}?</DialogTitle>
                    <DialogDescription>
                        {name} keeps access to anything you’ve already shared.
                    </DialogDescription>
                </DialogHeader>
                {error && (
                    <p role="alert" className="text-[13px] text-destructive">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => {
                            setError('');
                            setStage('mismatch');
                        }}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={saving}
                        onClick={() => {
                            if (lookup) void remove(lookup.contact.userId);
                        }}
                    >
                        Remove
                    </Button>
                </DialogFooter>
            </>
        );

    return (
        <>
            <DialogHeader>
                <DialogTitle>Check it’s {name}</DialogTitle>
                <DialogDescription>
                    {mismatch
                        ? `These don’t match. Check ${name}’s email address with them. If it’s right and they still don’t match, you can remove ${name} from your contacts for now and add them again once they do. To stop sharing something with ${name}, choose Share on it, then Stop sharing.`
                        : `Ask ${name} to open Contacts in HushOS and choose Your twelve words. If theirs match these, it’s really them. Do it in person or on a call.`}
                </DialogDescription>
            </DialogHeader>
            {found.isPending && (
                <output className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="size-4" />
                    Getting their words
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
            {lookup && !lookup.upgraded && (
                <p className="text-sm leading-snug text-muted-foreground">
                    {notUpgradedWords(lookup.contact.name)}
                </p>
            )}
            {lookup?.fingerprint && !mismatch && (
                <div className="flex flex-col gap-3">
                    {vouched && (
                        <p data-vouched className="text-[13px] text-muted-foreground">
                            {vouched}
                        </p>
                    )}
                    {replacedAt && (
                        <p data-followed className="text-[13px] text-muted-foreground">
                            {name} updated their account on {formatDay(replacedAt)}.
                        </p>
                    )}
                    <FingerprintWords fingerprint={lookup.fingerprint} pairs />
                    <details className="group">
                        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[13px] font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                            Technical details
                            <ChevronDownIcon
                                aria-hidden="true"
                                className="size-3.5 transition-transform group-open:rotate-180"
                            />
                        </summary>
                        <p className="mt-2 text-[13px] text-muted-foreground">
                            These words are worked out from {name}’s four public keys. Comparing
                            them confirms the keys HushOS gave your device are theirs.
                        </p>
                        <p
                            data-fingerprint={lookup.fingerprint}
                            className="mt-2 rounded-md bg-muted px-3 py-2 font-mono text-[13px] leading-relaxed wrap-anywhere"
                        >
                            {lookup.fingerprint}
                        </p>
                    </details>
                </div>
            )}
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                {!lookup?.fingerprint ? (
                    <Button variant="outline" onClick={onDone}>
                        {lookup ? 'Done' : 'Cancel'}
                    </Button>
                ) : mismatch ? (
                    <>
                        {lookup.pinned && (
                            <Button
                                variant="outline"
                                disabled={saving}
                                onClick={() => setStage('remove')}
                            >
                                Remove {name} from contacts
                            </Button>
                        )}
                        <Button onClick={onDone}>Done</Button>
                    </>
                ) : (
                    <>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => {
                                cue('error');
                                setStage('mismatch');
                            }}
                        >
                            They don’t match
                        </Button>
                        <Button disabled={saving} onClick={() => void theyMatch(lookup)}>
                            {saving ? 'Saving…' : 'They match'}
                        </Button>
                    </>
                )}
            </div>
        </>
    );
}
