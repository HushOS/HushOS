import type { DriveNode } from '@hushos/drive/client';
import { useNavigate } from '@tanstack/react-router';
import { driveClient } from '@/lib/drive';

/* Where a node lives and how to open it from anywhere: a folder by going in, a file by previewing it in its folder. */
export function useOpenNode() {
    const navigate = useNavigate();
    const rootId = driveClient.workspace?.root?.id ?? null;
    const folderLink = (folderId: string) =>
        folderId === rootId
            ? ({ to: '/app/drive' } as const)
            : ({ to: '/app/drive/f/$folderId', params: { folderId } } as const);
    return {
        folderLink,
        open: (node: DriveNode) => {
            if (node.kind === 'folder') void navigate(folderLink(node.id));
            else if (node.parentId)
                void navigate({ ...folderLink(node.parentId), search: { preview: node.id } });
        },
        reveal: (node: DriveNode) => {
            if (node.parentId) void navigate(folderLink(node.parentId));
        },
    };
}
