import type { DriveNode } from '@hushos/drive/client';
import { dropTargetForExternal } from '@atlaskit/pragmatic-drag-and-drop/external/adapter';
import { containsFiles } from '@atlaskit/pragmatic-drag-and-drop/external/file';
import { preventUnhandled } from '@atlaskit/pragmatic-drag-and-drop/prevent-unhandled';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, FolderUpIcon, UploadIcon } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { collectDroppedFiles, filesFromInput } from '@/lib/dropped-files';
import { driveError } from '@/lib/drive';
import { enqueueDropped } from '@/lib/uploads';

export type UploadPicker = { pickFiles: () => void; pickFolder: () => void };

/*
 * The Upload button: files, or a whole folder. The pickers are hidden inputs, so
 * the palette and shortcuts can open them too through the handle.
 */
export function UploadMenu({
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
        // The FileList is live: copy it before clearing the input for the next pick.
        const list = Array.from(input.files ?? []);
        input.value = '';
        if (!list.length) return;
        try {
            await enqueueDropped(queryClient, folder, filesFromInput(list), known);
        } catch (error) {
            toast.add({
                type: 'error',
                title: 'Could not start the upload',
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
                // Non-standard but universal: pick a directory and get its files with paths.
                {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                onChange={(event) => void picked(event.currentTarget)}
            />
            <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="sm" />}>
                    <UploadIcon />
                    Upload
                    <ChevronDownIcon className="-mr-1 size-3 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={() => files.current?.click()}>
                        <UploadIcon />
                        Files
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => directory.current?.click()}>
                        <FolderUpIcon />
                        Folder
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
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
                            title: 'Could not start the upload',
                            description: driveError(error),
                        }),
                    );
            },
        });
    }, [ref, queryClient]);
    return over;
}
