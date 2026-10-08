import type { DriveNode } from '@hushos/drive/client';
import { dropTargetForExternal } from '@atlaskit/pragmatic-drag-and-drop/external/adapter';
import { containsFiles } from '@atlaskit/pragmatic-drag-and-drop/external/file';
import { preventUnhandled } from '@atlaskit/pragmatic-drag-and-drop/prevent-unhandled';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react';
import { toast } from '@/components/ui/toast';
import { collectDroppedFiles, filesFromInput } from '@/lib/dropped-files';
import { driveError } from '@/lib/drive';
import { enqueueDropped } from '@/lib/uploads';

export type UploadPicker = { pickFiles: () => void; pickFolder: () => void };

/*
 * The pickers behind Add: files, or a whole folder. They are hidden inputs, so the
 * Add menu, the palette, the folder's own menu and the empty state can all open
 * them through the handle.
 */
export function UploadInputs({
    folder,
    known,
    handle,
}: {
    folder: DriveNode;
    known: DriveNode[];
    handle?: Ref<UploadPicker>;
}) {
    const queryClient = useQueryClient();
    const files = useRef<HTMLInputElement>(null);
    const directory = useRef<HTMLInputElement>(null);
    useImperativeHandle(handle, () => ({
        pickFiles: () => files.current?.click(),
        pickFolder: () => directory.current?.click(),
    }));
    async function picked(input: HTMLInputElement) {
        const list = Array.from(input.files ?? []);
        input.value = '';
        if (!list.length) return;
        try {
            await enqueueDropped(queryClient, folder, filesFromInput(list), known);
        } catch (error) {
            toast.add({
                type: 'error',
                title: 'Couldn’t start the upload',
                description: driveError(error),
            });
        }
    }
    return (
        <>
            <input
                ref={files}
                type="file"
                multiple
                hidden
                onChange={(event) => void picked(event.currentTarget)}
            />
            <input
                ref={directory}
                type="file"
                hidden
                {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                onChange={(event) => void picked(event.currentTarget)}
            />
        </>
    );
}

/*
 * Makes an element accept files from the desktop. Folders arrive as entries and
 * are walked; the browser only exposes them during the drop, so items are read
 * synchronously before anything awaits.
 */
export function useDropZone(
    ref: RefObject<HTMLElement | null>,
    folder: DriveNode | undefined,
    known: DriveNode[],
) {
    const queryClient = useQueryClient();
    const [over, setOver] = useState(false);
    const latest = useRef({ folder, known });
    useEffect(() => {
        latest.current = { folder, known };
    }, [folder, known]);
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        return dropTargetForExternal({
            element,
            canDrop: ({ source }) =>
                containsFiles({ source }) && latest.current.folder !== undefined,
            onDragEnter: () => {
                setOver(true);
                // Without this the browser would open a file dropped outside a target.
                preventUnhandled.start();
            },
            onDragLeave: () => {
                setOver(false);
                preventUnhandled.stop();
            },
            onDrop: ({ source }) => {
                setOver(false);
                preventUnhandled.stop();
                const target = latest.current.folder;
                if (!target) return;
                const items = [...source.items];
                void collectDroppedFiles(items)
                    .then((dropped) => {
                        if (!dropped.length) return;
                        return enqueueDropped(queryClient, target, dropped, latest.current.known);
                    })
                    .catch((error: unknown) =>
                        toast.add({
                            type: 'error',
                            title: 'Couldn’t start the upload',
                            description: driveError(error),
                        }),
                    );
            },
        });
    }, [ref, queryClient]);
    return over;
}
