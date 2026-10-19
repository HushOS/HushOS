import { createContext, useContext, useLayoutEffect } from 'react';

/*
 * The drive appears in one step. While DriveShell still shows "Opening your files", the page
 * beneath it is already mounted but hidden, and each placeholder it draws holds the shell's
 * line up; once none is left, the page is shown as it is, with its list. Afterwards this is
 * null and a placeholder holds nothing, so moving between pages loads as before.
 */
export const FirstPaintContext = createContext<(() => () => void) | null>(null);

/* Called by a page's loading placeholder: the first paint waits for it to go. */
export function useHoldFirstPaint() {
    const hold = useContext(FirstPaintContext);
    useLayoutEffect(() => hold?.(), [hold]);
}
