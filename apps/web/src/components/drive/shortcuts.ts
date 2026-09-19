/*
 * One list of Drive's keyboard shortcuts, so the hint overlay, the command
 * palette and the menus all say the same thing. `mod` renders as ⌘ or Ctrl.
 */
export type Shortcut = { id: string; keys: string[]; label: string };

export const shortcuts: Shortcut[] = [
    { id: 'palette', keys: ['Mod', 'K'], label: 'Command palette' },
    { id: 'new-folder', keys: ['Shift', 'N'], label: 'New folder' },
    { id: 'rename', keys: ['F2'], label: 'Rename' },
    { id: 'move', keys: ['M'], label: 'Move to…' },
    { id: 'copy', keys: ['C'], label: 'Copy to…' },
    { id: 'download', keys: ['D'], label: 'Download' },
    { id: 'tags', keys: ['T'], label: 'Tags…' },
    { id: 'trash', keys: ['Backspace'], label: 'Move to trash' },
    { id: 'open', keys: ['Enter'], label: 'Open' },
    { id: 'select-all', keys: ['Mod', 'A'], label: 'Select all' },
    { id: 'clear', keys: ['Escape'], label: 'Clear selection' },
];

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function keyLabel(key: string) {
    switch (key) {
        case 'Mod':
            return isMac ? '⌘' : 'Ctrl';
        case 'Shift':
            return isMac ? '⇧' : 'Shift';
        case 'Alt':
            return isMac ? '⌥' : 'Alt';
        case 'Backspace':
            return isMac ? '⌫' : 'Backspace';
        case 'Enter':
            return isMac ? '↩' : 'Enter';
        case 'Escape':
            return 'Esc';
        default:
            return key;
    }
}
