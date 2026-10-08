import { checkName } from '@hushos/drive/client';
import { cn } from 'cn';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { answerCollision, useCollisionPrompt, type CollisionPrompt } from '@/lib/collisions';

/*
 * "This name is taken": replace the existing file with a new version, keep
 * both under a name of the person's choosing, or skip, each choice saying what
 * it does. One prompt at a time; the checkbox carries the answer to the rest
 * of the drop, and closing the dialog skips this one file.
 */
export function CollisionDialog() {
    const prompt = useCollisionPrompt();
    return (
        <Dialog open={prompt !== null} onOpenChange={(open) => !open && prompt && skip(prompt)}>
            <DialogContent className="transition-none sm:max-w-[500px]">
                {prompt && <CollisionForm key={prompt.id} prompt={prompt} />}
            </DialogContent>
        </Dialog>
    );
}

function skip(prompt: CollisionPrompt) {
    answerCollision(prompt.id, { action: 'skip', all: false });
}

type Choice = 'replace' | 'keep' | 'skip';

const CHOICES: { value: Choice; label: string; detail: string }[] = [
    { value: 'replace', label: 'Replace', detail: 'Keeps the old one as an earlier version' },
    { value: 'keep', label: 'Keep both', detail: 'Adds this one under another name' },
    { value: 'skip', label: 'Skip', detail: 'Leaves the one here as it is' },
];

function CollisionForm({ prompt }: { prompt: CollisionPrompt }) {
    const id = useId();
    const [choice, setChoice] = useState<Choice>('replace');
    const [name, setName] = useState(prompt.suggested);
    const [all, setAll] = useState(false);
    const trimmed = name.trim();
    const taken = new Set(Array.from(prompt.taken, (entry) => entry.toLowerCase()));
    const nameError = (() => {
        if (!trimmed) return 'Enter a name.';
        try {
            checkName(trimmed);
        } catch (error) {
            return error instanceof Error ? error.message : 'Choose another name.';
        }
        return taken.has(trimmed.toLowerCase())
            ? `“${trimmed}” is already here too. Try another name.`
            : '';
    })();
    const folder = prompt.folderName === 'Drive' ? 'My files' : prompt.folderName;

    function answer() {
        if (choice === 'keep') {
            if (nameError) return;
            answerCollision(prompt.id, { action: 'keep', name: trimmed, all });
        } else answerCollision(prompt.id, { action: choice, all });
    }

    return (
        <form
            className="contents"
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                answer();
            }}
        >
            <DialogHeader>
                <DialogTitle>“{prompt.fileName}” is already here</DialogTitle>
                <DialogDescription>
                    “{folder}” already has a file with this name. What should happen to the one
                    you’re adding?
                </DialogDescription>
            </DialogHeader>
            <RadioGroup
                value={choice}
                onValueChange={(value) => setChoice(value as Choice)}
                aria-label="What to do"
                className="flex-col items-stretch gap-1"
            >
                {CHOICES.map((entry) => (
                    <label
                        key={entry.value}
                        htmlFor={`${id}-${entry.value}`}
                        className={cn(
                            'flex cursor-pointer items-start gap-3 rounded-md px-3 py-2.5',
                            choice === entry.value ? 'bg-accent' : 'hover:bg-muted',
                        )}
                    >
                        <RadioGroupItem
                            id={`${id}-${entry.value}`}
                            value={entry.value}
                            className="mt-0.5"
                        />
                        <span className="flex flex-col gap-0.5">
                            <span className="text-sm font-semibold">{entry.label}</span>
                            <span className="text-[13px] text-muted-foreground">
                                {entry.detail}
                            </span>
                        </span>
                    </label>
                ))}
            </RadioGroup>
            {choice === 'keep' && (
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={id} className="text-[13px] font-semibold">
                        Name for the new one
                    </label>
                    <Input
                        id={id}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={Boolean(nameError)}
                        aria-describedby={nameError ? `${id}-problem` : undefined}
                        maxLength={255}
                        className="h-11 text-[15px]"
                    />
                    {nameError && (
                        <p
                            id={`${id}-problem`}
                            role="alert"
                            className="text-[13px] text-destructive"
                        >
                            {nameError}
                        </p>
                    )}
                </div>
            )}
            {prompt.remaining > 0 && (
                <label className="flex items-center gap-2.5 text-sm">
                    <Checkbox checked={all} onCheckedChange={(value) => setAll(value === true)} />
                    <span>
                        Do the same for the {prompt.remaining} other{' '}
                        {prompt.remaining === 1 ? 'file' : 'files'} with taken names
                    </span>
                </label>
            )}
            <DialogFooter>
                <Button type="button" variant="outline" onClick={() => skip(prompt)}>
                    Cancel
                </Button>
                <Button type="submit" disabled={choice === 'keep' && Boolean(nameError)}>
                    Continue
                </Button>
            </DialogFooter>
        </form>
    );
}
