'use client';

import { Check, Clipboard, Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { downloadViaAnchor } from '@/lib/utils';
import { useCryptoStore } from '@/stores/crypto-store';
import { useStore } from '@/stores/use-store';

export function RecoveryKey() {
    let recoveryKey = useStore(useCryptoStore, state => state.recoveryKeyMnemonic);
    const [copied, copyAction] = useCopyToClipboard(recoveryKey ?? '');

    if (!recoveryKey) {
        return null;
    }

    const download = downloadViaAnchor.bind(null, recoveryKey, 'hushos-recovery-key.txt');

    return (
        <div className='flex flex-col gap-4'>
            <div className='rounded-md bg-secondary p-4 font-semibold'>
                <code className='font-mono'>{recoveryKey}</code>
            </div>
            <div className='flex items-center gap-2'>
                <Button className='gap-2' variant='secondary' onClick={download}>
                    Download <Download className='size-4' />
                </Button>
                <Button
                    className='gap-2'
                    variant='secondary'
                    onClick={copyAction}
                    disabled={copied}>
                    {copied ? (
                        <>
                            Copied <Check className='size-4' />
                        </>
                    ) : (
                        <>
                            Copy <Clipboard className='size-4' />
                        </>
                    )}
                </Button>
            </div>
        </div>
    );
}
