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
    TrustMovedError,
    type Lookup,
} from '@/lib/contacts';
import { driveClient, driveError, driveKeys, formatDay } from '@/lib/drive';
import { vouchLine } from '@/lib/family-pin';
import { afterTrustChanged } from '@/lib/integrity';
import { stopSharingWithPerson } from '@/lib/rotation';
import { cue } from '@/lib/sounds';

/* Who is being checked: from a contact, a share row, a mark or the changed-account notice. */
export type Checking = { email: string; name: string };

/*
 * Check it's Maya (docs/optional-verification.md 6.6), the advanced door: the
 * twelve words over the keys HushOS serves for them now, read against the
 * ones on their own device. They match makes the pin verified (over new keys,
 * it is also a Continue, and what was shared with them is sealed again);
 * They don't match saves nothing, and offers Stop sharing with Maya, the
 * remedy for shares sealed to keys that were not theirs. A step of the
 * contact flow (contact-flow.tsx): "Stop sharing with Maya?" replaces it in
 * the same dialog, and Cancel there comes back to it.
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
    /* The words, the words not matching, then (replacing it) Stop sharing with Maya? */
    const [stage, setStage] = useState<'words' | 'mismatch' | 'stop'>('words');
    const mismatch = stage !== 'words';
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const name = firstName(found.data?.contact.name ?? person.name);

    async function theyMatch(lookup: Lookup) {
        setSaving(true);
        setError('');
        try {
            await pinContact(queryClient, userId, lookup);
            // What they wrote now reads as verified, and what waited on them runs.
            afterTrustChanged(queryClient);
            void queryClient.invalidateQueries({ queryKey: driveKeys.shared });
            // Over keys that changed, a check is a Continue too: what was shared with them is
            // sealed again, to these keys only, as Continue does (account-changed.tsx).
            if (lookup.changed) void driveClient.upgradeShares().catch(() => {});
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

    async function stopSharing(contactId: string) {
        setSaving(true);
        try {
            await stopSharingWithPerson(queryClient, contactId);
            cue('droplet');
            toast.add({ type: 'success', title: `Stopped sharing with ${name}` });
            onDone();
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t stop sharing',
                // What was owed is kept: Drive finishes it when it next opens (lib/rotation.ts).
                description: `${driveError(cause)} HushOS finishes it the next time you open your files.`,
            });
        } finally {
            setSaving(false);
        }
    }

    const lookup = found.data;
    const replacedAt = lookup?.pinned?.keysReplacedAt ?? null;
    const vouched = lookup?.pinned ? vouchLine(lookup.pinned) : null;

    if (stage === 'stop')
        return (
            <>
                <DialogHeader>
                    <DialogTitle>Stop sharing with {name}?</DialogTitle>
                    <DialogDescription>
                        {name} can’t open anything you’ve shared with them any more, including what
                        you add to those folders later. You can share again once your words match.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => setStage('mismatch')}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={saving}
                        onClick={() => {
                            if (lookup) void stopSharing(lookup.contact.userId);
                        }}
                    >
                        Stop sharing
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
                        ? `These don’t match. Check ${name}’s email address with them. If it’s right and they still don’t match, you can stop sharing with ${name} for now and share again once they do.`
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
                                onClick={() => setStage('stop')}
                            >
                                Stop sharing with {name}
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
