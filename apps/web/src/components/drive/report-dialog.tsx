import type { ReportCategory } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { driveError } from '@/lib/drive';
import { CATEGORIES, fileReport } from '@/lib/reports';
import { cue } from '@/lib/sounds';

/*
 * Reporting something seen through a link or a share. The key to what was
 * reported is sealed on this device to the instance's operators, so a report
 * is the one act that gives anyone but the sharer's audience a way in, and it
 * is theirs alone to open. The person who shared it is not told who reported.
 */
export function ReportDialog({
    node,
    via,
    signedIn,
    open,
    onOpenChange,
}: {
    node: DriveNode | null;
    via: { link: string } | { share: true };
    signedIn: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[520px]">
                {node && (
                    <ReportForm
                        key={node.id}
                        node={node}
                        via={via}
                        signedIn={signedIn}
                        onDone={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function ReportForm({
    node,
    via,
    signedIn,
    onDone,
}: {
    node: DriveNode;
    via: { link: string } | { share: true };
    signedIn: boolean;
    onDone: () => void;
}) {
    const id = useId();
    const [category, setCategory] = useState<ReportCategory | ''>('');
    const [reason, setReason] = useState('');
    const [email, setEmail] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');

    async function submit() {
        if (!category || !reason.trim()) return;
        setPending(true);
        setError('');
        try {
            const result = await fileReport(node, {
                category,
                reason: reason.trim(),
                via,
                reporterEmail: signedIn ? null : email.trim() || null,
            });
            cue('success');
            toast.add({
                type: 'success',
                title: result.duplicate ? 'Already reported' : 'Report sent',
                description: result.duplicate
                    ? `You’ve reported “${node.name}” before. They have it; there’s nothing more to do.`
                    : `Thank you. The people who run this HushOS can now open “${node.name}” and will look at it.`,
            });
            onDone();
        } catch (cause) {
            cue('error');
            setError(driveError(cause));
        } finally {
            setPending(false);
        }
    }

    return (
        <form
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
            className="contents"
        >
            <DialogHeader>
                <DialogTitle>Report “{node.name}”</DialogTitle>
                <DialogDescription>
                    Reporting lets the people who run this HushOS open{' '}
                    {node.kind === 'folder' ? 'this folder and everything inside it' : 'this file'},
                    so they can look. Whoever shared it isn’t told who reported it.
                </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
                <label htmlFor={`${id}-category`} className="text-[13px] font-semibold">
                    What is it?
                </label>
                <Select
                    value={category}
                    onValueChange={(value) => setCategory((value as ReportCategory) ?? '')}
                    items={CATEGORIES}
                >
                    <SelectTrigger
                        id={`${id}-category`}
                        aria-label="Category"
                        className="w-full min-w-0 text-[15px]"
                    >
                        <SelectValue placeholder="Choose what it is" />
                    </SelectTrigger>
                    <SelectContent>
                        {CATEGORIES.map((entry) => (
                            <SelectItem key={entry.value} value={entry.value}>
                                {entry.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="flex flex-col gap-1.5">
                <label htmlFor={`${id}-reason`} className="text-[13px] font-semibold">
                    What’s wrong with it?
                </label>
                <Textarea
                    id={`${id}-reason`}
                    value={reason}
                    maxLength={2000}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="What you saw, and where inside it"
                    className="min-h-24 text-[15px]"
                />
            </div>
            {!signedIn && (
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={`${id}-email`} className="text-[13px] font-semibold">
                        Your email (optional)
                    </label>
                    <Input
                        id={`${id}-email`}
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        aria-describedby={`${id}-email-hint`}
                        className="text-[15px]"
                    />
                    <p id={`${id}-email-hint`} className="text-[13px] text-muted-foreground">
                        Only if you want to hear back.
                    </p>
                </div>
            )}
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    Couldn’t send the report. {error}
                </p>
            )}
            <DialogFooter>
                <Button type="button" variant="outline" onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit" disabled={pending || !category || !reason.trim()}>
                    {pending ? 'Sending…' : 'Send report'}
                </Button>
            </DialogFooter>
        </form>
    );
}
