import { MarkdownView } from '@/components/drive/rich-text';

/*
 * The text editor's Markdown preview: the viewer's renderer, its code fences plain until the
 * viewers' post-unlock preload has every grammar. A module of its own, fetched with the editor's
 * other assets for every file it opens (text-editor.tsx editorAssets), never only for Markdown, so
 * which chunks a device fetched never says what kind of file was edited.
 */
export function EditorPreview({ text }: { text: string }) {
    return <MarkdownView text={text} fences="after-preload" />;
}
