import { useCallback, useEffect, useState } from 'react';

export function useCopyToClipboard(value: string): [boolean, () => Promise<void>] {
    const [copyableString, setCopyableString] = useState(value);
    const [copied, setCopied] = useState(false);

    const copyAction = useCallback(async () => {
        if (!navigator.clipboard) {
            setCopied(false);
            console.warn('Clipboard API not available');
            return;
        }

        try {
            await navigator.clipboard.writeText(copyableString);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }, [copyableString]);

    useEffect(() => {
        setCopyableString(value);
    }, [value]);

    useEffect(() => {
        if (copied) {
            const timeout = setTimeout(() => {
                setCopied(false);
            }, 2000);

            return () => {
                clearTimeout(timeout);
            };
        }
    }, [copied]);

    return [copied, copyAction];
}
