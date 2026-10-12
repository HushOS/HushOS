import type { DriveNode } from '@hushos/drive/client';
import type { Signer } from '@hushos/drive/api';
import { integrityIssues, type IntegrityIssue } from '@hushos/drive/trust';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { CheckContact } from '@/components/drive/check-contact';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { afterTrustChanged, issueLines, reconsiderSigner } from '@/lib/integrity';

/*
 * The Unverified mark: an item whose name or current version this person
 * cannot tie to someone they checked. One small mark per item, whatever
 * failed; hover or a click says which case it is and who the server says
 * wrote it, with "Check their words" where that clears it. Verified items,
 * and anything never checked (a link visitor's view), show nothing. It warns;
 * it never stops the item opening.
 */
export function UnverifiedMark({
    node,
    issues: given,
    className,
}: {
    node?: Pick<DriveNode, 'name' | 'metadataSigner' | 'currentVersion' | 'integrity'>;
    /* For a record other than an item's current state, such as an earlier version. */
    issues?: IntegrityIssue[];
    className?: string;
}) {
    const issues = given ?? (node ? integrityIssues(node) : []);
    const queryClient = useQueryClient();
    const userId = useStore(authClient.store, (state) => state.unlockedUserId);
    const [open, setOpen] = useState(false);
    const [checking, setChecking] = useState<Signer | null>(null);
    // A contact's bad signature may be keys of theirs this device has not followed yet.
    const suspect = issues.find((issue) => issue.integrity === 'bad-signature')?.signer ?? null;
    useEffect(() => {
        if (suspect && userId) void reconsiderSigner(queryClient, userId, suspect);
    }, [suspect, userId, queryClient]);
    if (!issues.length) return null;
    const lines = issueLines(issues);
    const check = lines.find((entry) => entry.check)?.check ?? null;
    const worst = issues[0]!.integrity;
    return (
        <>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger
                    openOnHover
                    delay={150}
                    data-integrity={worst}
                    aria-label={`Unverified: ${lines.map((entry) => entry.text).join(' ')}`}
                    onClick={(event) => {
                        // A click keeps it open; hover already opened it, so the default would shut it.
                        event.stopPropagation();
                        event.preventBaseUIHandler();
                        setOpen(true);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    className={cn(
                        'eyebrow inline-flex h-5 shrink-0 cursor-pointer items-center rounded-xs border border-transparent bg-warning-soft px-1.5 whitespace-nowrap text-warning outline-none transition-colors hover:border-warning/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-popup-open:border-warning/40',
                        className,
                    )}
                >
                    Unverified
                </PopoverTrigger>
                <PopoverContent
                    className="flex w-72 flex-col gap-2 p-3"
                    data-integrity-details
                    onClick={(event) => event.stopPropagation()}
                >
                    <p className="text-sm font-semibold">Unverified</p>
                    {lines.map((entry) => (
                        <p key={entry.text} className="text-[13px] leading-snug">
                            {entry.text}
                        </p>
                    ))}
                    {check && userId && (
                        <Button
                            size="sm"
                            variant="outline"
                            className="mt-1 self-start"
                            onClick={(event) => {
                                event.stopPropagation();
                                setOpen(false);
                                setChecking(check);
                            }}
                        >
                            Check their words
                        </Button>
                    )}
                </PopoverContent>
            </Popover>
            {userId && (
                <Dialog
                    open={checking !== null}
                    onOpenChange={(next) => !next && setChecking(null)}
                >
                    <DialogContent
                        className="sm:max-w-[480px]"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <DialogHeader>
                            <DialogTitle>Check it’s {checking?.name ?? 'them'}</DialogTitle>
                            <DialogDescription>
                                Once their words match, what they add and change shows as verified.
                            </DialogDescription>
                        </DialogHeader>
                        {checking && (
                            <CheckContact
                                userId={userId}
                                email={checking.email}
                                onCancel={() => setChecking(null)}
                                onAdded={(pin) => {
                                    setChecking(null);
                                    afterTrustChanged(queryClient);
                                    toast.add({ type: 'success', title: `${pin.name} checked` });
                                }}
                            />
                        )}
                    </DialogContent>
                </Dialog>
            )}
        </>
    );
}
