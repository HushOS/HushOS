import { FOLDER_COLOURS, folderColour, type DriveNode, type TagColour } from '@hushos/drive/client';
import { useQueryClient } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import { cn } from 'cn';
import { useId, useState } from 'react';
import { swatchColour } from '@/components/folder-mark';
import { CustomColour } from '@/components/drive/tag-colour';
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
import { clientFor, driveError, invalidateFolders } from '@/lib/drive';
import { cue } from '@/lib/sounds';

/*
 * A folder's colour: the swatches as round buttons and one of your own, the tag
 * picker's square, hue strip and hex. Choosing only marks the choice; Save seals
 * it into each folder's record, one signed write per folder rather than one per
 * swatch tried.
 */

/* Where Custom starts: the plum the swatches leave out. */
const FIRST_CUSTOM = '#7c5cbf';
/* The swatches' names, in FOLDER_COLOURS' order, for screen readers. */
const SWATCH_NAMES = ['Blue', 'Mint', 'Coral', 'Violet', 'Teal', 'Pink', 'Lime', 'Orange'];

export function FolderColourDialog({
    nodes,
    onOpenChange,
}: {
    nodes: DriveNode[] | null;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={nodes !== null && nodes.length > 0} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-115">
                {nodes && nodes.length > 0 && (
                    <ColourForm
                        key={nodes.map((node) => node.id).join(',')}
                        nodes={nodes}
                        onOpenChange={onOpenChange}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function ColourForm({
    nodes,
    onOpenChange,
}: {
    nodes: DriveNode[];
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const [value, setValue] = useState(() => folderColour(nodes[0]!));
    const swatch = (FOLDER_COLOURS as readonly string[]).includes(value);
    const [customOpen, setCustomOpen] = useState(!swatch);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const what = nodes.length === 1 ? `“${nodes[0]!.name}”` : `${nodes.length} folders`;

    async function submit() {
        const changing = nodes.filter((node) => folderColour(node) !== value);
        if (!changing.length) {
            onOpenChange(false);
            return;
        }
        setPending(true);
        setError('');
        try {
            const parents = new Set<string | null>();
            for (const node of changing) {
                const saved = await clientFor(node.workspaceId).recolour(node, value);
                parents.add(saved.parentId);
            }
            await Promise.all([...parents].map((parent) => invalidateFolders(queryClient, parent)));
            cue('success');
            onOpenChange(false);
        } catch (error) {
            cue('error');
            setError(driveError(error));
        } finally {
            setPending(false);
        }
    }

    const ring = (on: boolean) =>
        cn(
            'relative flex size-9 cursor-pointer items-center justify-center rounded-full border-2 outline-none has-focus-visible:outline-2 has-focus-visible:outline-solid has-focus-visible:outline-offset-1 has-focus-visible:outline-ring has-disabled:cursor-not-allowed has-disabled:opacity-50 pointer-coarse:size-11',
            on ? 'border-foreground' : 'border-transparent hover:border-rule',
        );

    return (
        <form
            className="contents"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <DialogHeader>
                <DialogTitle>Colour for {what}</DialogTitle>
                <DialogDescription>
                    People who can open {nodes.length === 1 ? 'this folder' : 'these folders'} see
                    the colour too.
                </DialogDescription>
            </DialogHeader>
            <fieldset
                aria-label="Colour"
                disabled={pending}
                className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
            >
                <div className="flex flex-wrap items-center gap-1">
                    {FOLDER_COLOURS.map((colour, index) => (
                        <label key={colour} className={ring(value === colour)}>
                            <input
                                type="radio"
                                name={id}
                                value={colour}
                                aria-label={SWATCH_NAMES[index]}
                                checked={value === colour}
                                onChange={() => {
                                    setCustomOpen(false);
                                    setValue(colour);
                                }}
                                className="absolute inset-0 size-full cursor-pointer appearance-none rounded-full"
                            />
                            <span
                                aria-hidden="true"
                                className="pointer-events-none flex size-6 items-center justify-center rounded-full"
                                style={{ background: swatchColour(colour) }}
                            >
                                {value === colour && (
                                    <CheckIcon className="size-3.5 text-white" strokeWidth={3} />
                                )}
                            </span>
                        </label>
                    ))}
                    <label className={ring(!swatch)}>
                        <input
                            type="radio"
                            name={id}
                            value="custom"
                            aria-label="Custom colour"
                            checked={!swatch}
                            onChange={() => {
                                setCustomOpen(true);
                                if (swatch) setValue(FIRST_CUSTOM);
                            }}
                            onClick={() => setCustomOpen(true)}
                            className="absolute inset-0 size-full cursor-pointer appearance-none rounded-full"
                        />
                        <span
                            aria-hidden="true"
                            className="pointer-events-none size-6 rounded-full"
                            style={{
                                background: swatch
                                    ? `conic-gradient(${FOLDER_COLOURS.map(swatchColour).join(', ')}, ${swatchColour(FOLDER_COLOURS[0])})`
                                    : swatchColour(value),
                            }}
                        />
                    </label>
                </div>
                {customOpen && (
                    <div className="border-t border-rule pt-3">
                        <CustomColour
                            key={swatch ? 'swatch' : 'custom'}
                            value={swatch ? FIRST_CUSTOM : value}
                            disabled={pending}
                            onChoose={(hex: TagColour) => setValue(hex.toLowerCase())}
                        />
                    </div>
                )}
                {error && (
                    <p role="alert" className="text-[13px] text-destructive">
                        {error}
                    </p>
                )}
            </fieldset>
            <DialogFooter>
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                    disabled={pending}
                >
                    Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                    <PendingLabel pending={pending} idle="Save" busy="Saving" />
                </Button>
            </DialogFooter>
        </form>
    );
}
