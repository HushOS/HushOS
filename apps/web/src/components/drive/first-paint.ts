import { createContext, useContext, useLayoutEffect } from 'react';

/*
 * The drive appears in one step. On the first open after sign-in, unlock or a reload, while
 * DriveShell still shows "Opening your files", the page beneath it is already mounted but
 * hidden (and takes no keys), and each placeholder it draws holds the shell's line up; once
 * none is left, or the line has said "Still opening", the page is shown as it is. Afterwards
 * this is null and a placeholder holds nothing, so moving between pages loads as before, and
 * coming back to Drive from Account or Billing shows the page at once.
 */
export const FirstPaintContext = createContext<(() => () => void) | null>(null);

/* Called by a page's loading placeholder: the first paint waits for it to go. */
export function useHoldFirstPaint() {
    const hold = useContext(FirstPaintContext);
    useLayoutEffect(() => hold?.(), [hold]);
}
