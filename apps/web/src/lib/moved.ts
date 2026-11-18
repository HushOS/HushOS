/*
 * What the person used last, the keyboard or a pointer, kept on the page as `data-moved` on
 * <html>. Menus, selects, the command palette, the share dialog's picker and the autocomplete
 * ring their highlighted item only while it is the keyboard (`in-data-[moved=keyboard]:`); a
 * pointer has the fill to follow. One record for the page, not one per list: a submenu that
 * hands focus back to its parent, a list that opens on the key that typed into its field, and a
 * list reopened by a click all ask the same question. `:focus-visible` can't answer it (Chrome
 * keeps the keyboard's flag when a menu moves focus under the mouse, and the palette's focus
 * stays in its field), and neither can `:hover` (a pointer resting over a list would hide the
 * ring from the keyboard). A key held alone as a modifier is not a move, and a pointermove
 * that did not move (WebKit sends one as a list scrolls under a still pointer) is not either.
 */
const MODIFIERS = new Set([
    'Alt',
    'AltGraph',
    'CapsLock',
    'Control',
    'Fn',
    'Meta',
    'NumLock',
    'ScrollLock',
    'Shift',
]);

let tracking = false;

export function trackMoved() {
    if (tracking) return;
    tracking = true;
    const root = document.documentElement;
    const mark = (by: 'keyboard' | 'pointer') => {
        if (root.dataset.moved !== by) root.dataset.moved = by;
    };
    let at = { x: Number.NaN, y: Number.NaN };
    // Capture, on the window: a list that stops a key's propagation still counts it.
    window.addEventListener(
        'keydown',
        (event) => {
            if (!MODIFIERS.has(event.key)) mark('keyboard');
        },
        { capture: true },
    );
    window.addEventListener(
        'pointerdown',
        (event) => {
            at = { x: event.clientX, y: event.clientY };
            mark('pointer');
        },
        { capture: true },
    );
    window.addEventListener(
        'pointermove',
        (event) => {
            const first = Number.isNaN(at.x);
            if (event.clientX === at.x && event.clientY === at.y) return;
            at = { x: event.clientX, y: event.clientY };
            // The first move after a load only says where the pointer rests; a real one follows.
            if (!first) mark('pointer');
        },
        { capture: true, passive: true },
    );
    // A wheel scrolls a list under a still pointer, and the item now under it takes the highlight.
    window.addEventListener('wheel', () => mark('pointer'), { capture: true, passive: true });
}
