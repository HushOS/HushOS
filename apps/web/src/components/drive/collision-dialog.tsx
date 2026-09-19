import { checkName } from '@hushos/drive/client';
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
import { answerCollision, useCollisionPrompt, type CollisionPrompt } from '@/lib/collisions';

/*
 * "This name is taken": replace the existing file with a new version, keep
 * both under a name of the person's choosing, or skip. One prompt at a time;
 * the checkbox carries the answer to the rest of the drop.
 */
export function CollisionDialog() {
    const prompt = useCollisionPrompt();
    return (
        <Dialog open={prompt !== null} onOpenChange={(open) => !open && prompt && skip(prompt)}>
            <DialogContent className="transition-none">
                {prompt && <CollisionForm key={prompt.id} prompt={prompt} />}
            </DialogContent>
        </Dialog>
    );
}

function skip(prompt: CollisionPrompt) {
    answerCollision(prompt.id, { action: 'skip', all: false });
}

function CollisionForm({ prompt }: { prompt: CollisionPrompt }) {
    const id = useId();
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
        return taken.has(trimmed.toLowerCase()) ? 'That name is taken here too.' : '';
    })();

    return (
        <form
            className="contents"
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                answerCollision(prompt.id, { action: 'replace', all });
            }}
        >
            <DialogHeader>
                <DialogTitle>“{prompt.fileName}” already exists</DialogTitle>
                <DialogDescription>
                    {prompt.folderName === 'Drive'
                        ? 'The top folder'
                        : `The folder “${prompt.folderName}”`}{' '}
                    already has a file with this name. Replace it and keep the current one as its
                    earlier version, keep both under another name, or skip this file.
                </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
                <label htmlFor={id} className="eyebrow text-muted-foreground">
                    Name if you keep both
                </label>
                <Input
                    id={id}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(nameError)}
                    maxLength={255}
                />
                {nameError && (
                    <p role="alert" className="text-xs text-destructive">
                        {nameError}
                    </p>
                )}
            </div>
            {prompt.remaining > 0 && (
                <label className="flex items-center gap-3 text-sm">
                    <Checkbox checked={all} onCheckedChange={(value) => setAll(value === true)} />
                    <span>
                        Do the same for the {prompt.remaining} other{' '}
                        {prompt.remaining === 1 ? 'file' : 'files'} with taken names
                    </span>
                </label>
            )}
            <DialogFooter>
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => answerCollision(prompt.id, { action: 'skip', all })}
                >
                    Skip
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    disabled={Boolean(nameError)}
                    onClick={() =>
                        answerCollision(prompt.id, { action: 'keep', name: trimmed, all })
                    }
                >
                    Keep both
                </Button>
                <Button type="submit">Replace</Button>
            </DialogFooter>
        </form>
    );
}
