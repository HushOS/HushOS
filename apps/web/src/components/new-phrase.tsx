import { useState, type ReactNode } from 'react';
import { AuthActions, AuthFields, AuthLayout, AuthNote } from '@/components/auth-layout';
import { PhraseGrid } from '@/components/recovery-phrase';
import { Button } from '@/components/ui/button';
import { copySecret } from '@/lib/clipboard';
import type { NewPhrase as Made } from '@/lib/new-phrase';
import { cue } from '@/lib/sounds';

/*
 * The recovery phrase a reset or a rotation made, for someone it did not sign in again here.
 * Each replaces the phrase, and the page that normally shows the new one is behind the
 * sign-in. Someone whose only second step is their phrase could then never get there: the old
 * words are dead and the new ones were never shown. So they are shown here, once, before
 * the sign-in. `action` is the way on: to the sign-in form.
 */

const words = {
    reset: {
        applied:
            'Your password is changed, and your old recovery phrase no longer works. These 24 words replace it.',
        unknown:
            'We couldn’t confirm that your password was changed. If it was, these 24 words are your recovery phrase now. If it wasn’t, your old phrase still is. Keep both until you have signed in.',
    },
    rotation: {
        applied: 'Your old recovery phrase no longer works. These 24 words replace it.',
        unknown:
            'We couldn’t confirm that your recovery phrase was replaced. If it was, these 24 words are your recovery phrase now. If it wasn’t, your old phrase still is. Keep both until you know which one your account uses.',
    },
} as const;

export function NewPhrase({ made, action }: { made: Made; action: ReactNode }) {
    const [copied, setCopied] = useState(false);
    const [blocked, setBlocked] = useState(false);
    async function copy() {
        try {
            await copySecret(made.phrase);
            cue('success', { volume: 0.4 });
            setCopied(true);
            setBlocked(false);
        } catch {
            cue('error');
            setBlocked(true);
        }
    }
    return (
        <AuthLayout
            wide
            title="Save your new recovery phrase"
            art="KEYS"
            description={words[made.from][made.applied === true ? 'applied' : 'unknown']}
        >
            <AuthFields>
                {made.storage && (
                    <AuthNote tone="warning">
                        {made.storage.replace(/^./, (first) => first.toUpperCase())}, so you weren’t
                        signed in here.
                    </AuthNote>
                )}
                <PhraseGrid phrase={made.phrase} />
                <p className="text-sm text-muted-foreground">
                    They are shown here once. If your account asks for a second step when you sign
                    in, these words answer it.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                    <Button type="button" variant="outline" onClick={() => void copy()}>
                        {copied ? 'Copied' : 'Copy'}
                    </Button>
                    {copied && (
                        <output className="text-[13px] text-muted-foreground">
                            Cleared from the clipboard in two minutes.
                        </output>
                    )}
                    {blocked && (
                        <span role="alert" className="text-[13px] text-destructive">
                            Copying isn’t available here. Write the words down instead.
                        </span>
                    )}
                </div>
                <AuthActions action={action} />
            </AuthFields>
        </AuthLayout>
    );
}
