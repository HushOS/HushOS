import type { ReportCategory } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { FlagIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { PendingLabel } from '@/components/motion';
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

/* A label beside its field; stacked where the dialog is narrow. */
const ROW = 'grid items-center gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[8rem_minmax(0,1fr)]';

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
            <DialogContent className="sm:max-w-lg">
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
                    ? 'Your earlier report on this item is still open with the operators.'
                    : 'The operators of this instance can now open what you reported. Nobody else can.',
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
                    Reporting hands the operators of this instance the key to this item
                    {node.kind === 'folder' ? ' and everything inside it' : ''}, sealed on your
                    device to them alone. The person who shared it is not told who reported.
                </DialogDescription>
            </DialogHeader>
            <div className="flex min-w-0 flex-col divide-y divide-rule border-y border-rule">
                <div className={ROW}>
                    <label htmlFor={`${id}-category`} className="eyebrow text-muted-foreground">
                        What is it
                    </label>
                    <Select
                        value={category}
                        onValueChange={(value) => setCategory((value as ReportCategory) ?? '')}
                        items={CATEGORIES}
                    >
                        <SelectTrigger
                            id={`${id}-category`}
                            aria-label="Category"
                            className="w-full min-w-0"
                        >
                            <SelectValue placeholder="Choose a category" />
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
                <div className={ROW}>
                    <label
                        htmlFor={`${id}-reason`}
                        className="eyebrow text-muted-foreground sm:self-start sm:pt-3"
                    >
                        What is wrong
                    </label>
                    <Textarea
                        id={`${id}-reason`}
                        value={reason}
                        maxLength={2000}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="What you saw, and where inside it if it is a folder."
                        className="min-h-28"
                    />
                </div>
                {!signedIn && (
                    <div className={ROW}>
                        <label htmlFor={`${id}-email`} className="eyebrow text-muted-foreground">
                            Your email
                        </label>
                        <Input
                            id={`${id}-email`}
                            type="email"
                            autoComplete="email"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            placeholder="Optional, in case the operators have questions"
                        />
                    </div>
                )}
                {error && (
                    <p role="alert" className="py-3 text-xs text-destructive">
                        {error}
                    </p>
                )}
            </div>
            <DialogFooter>
                <Button type="button" variant="ghost" onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit" disabled={pending || !category || !reason.trim()}>
                    <FlagIcon />
                    <PendingLabel pending={pending} idle="Send report" busy="Sealing" />
                </Button>
            </DialogFooter>
        </form>
    );
}
