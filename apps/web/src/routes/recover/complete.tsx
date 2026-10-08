import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@hushos/auth/protocol';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { cn } from 'cn';
import { CircleCheckIcon, FileTextIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { AuthInput, StrengthHint } from '@/components/auth-input';
import { AuthActions, AuthFields, AuthLayout, AuthNote, authLink } from '@/components/auth-layout';
import { PhraseGrid } from '@/components/recovery-phrase';
import { VerifiedEmailStep } from '@/components/verified-email-step';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { getRecoveryEnrollment } from '@/lib/auth';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { phraseFromKit, WORDS } from '@/lib/recovery-kit';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/recover/complete')({
    loader: () => getRecoveryEnrollment(),
    staleTime: 0,
    gcTime: 0,
    component: () => (
        <VerifiedEmailStep initialEnrollment={Route.useLoaderData()} purpose="recover">
            {(enrollment) => <RecoverForm enrollment={enrollment} />}
        </VerifiedEmailStep>
    ),
});

/*
 * After the email is confirmed: the recovery kit shows the account is theirs,
 * then a new password. The kit file comes first, read on this device and never
 * uploaded; typing the 24 words is the second way, for a kit written by hand.
 */

const wordsOf = (text: string) => text.trim().toLowerCase().split(/\s+/).filter(Boolean);

function RecoverForm({ enrollment }: { enrollment: { email: string } }) {
    const router = useRouter();
    const id = useId();
    const [mode, setMode] = useState<'kit' | 'typing'>('kit');
    const [kit, setKit] = useState<{ file: string; words: string[] } | null>(null);
    const [notKit, setNotKit] = useState(false);
    const [over, setOver] = useState(false);
    const [typed, setTyped] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [tried, setTried] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const count = wordsOf(typed).length;
    const words = mode === 'kit' ? (kit?.words ?? null) : wordsOf(typed);
    const ready = mode === 'kit' ? kit !== null : true;

    async function read(file: File) {
        setError('');
        // A kit is a few kilobytes; anything much larger isn't one.
        const found = file.size < 64 * 1024 ? phraseFromKit(await file.text()) : null;
        if (!found) {
            cue('error');
            setNotKit(true);
            setKit(null);
            return;
        }
        cue('success', { volume: 0.4 });
        setNotKit(false);
        setKit({ file: file.name, words: found });
    }

    const errors = {
        typed:
            mode === 'typing' && count !== WORDS
                ? `${count < WORDS ? `${WORDS - count} ${WORDS - count === 1 ? 'word' : 'words'} missing.` : 'Too many words.'} Type all ${WORDS}, in order, with spaces between them.`
                : '',
        password:
            password.length < PASSWORD_MIN_LENGTH
                ? `Use at least ${PASSWORD_MIN_LENGTH} characters.`
                : '',
        confirm: confirm === password ? '' : 'The passwords don’t match.',
    };

    async function submit() {
        setTried(true);
        if (!words || errors.typed || errors.password || errors.confirm) return;
        setPending(true);
        setError('');
        try {
            await authClient.recover(enrollment.email, password, words.join(' '));
            cue('success');
            router.options.context.queryClient.clear();
            await router.navigate({ to: '/setup/recovery-key', replace: true });
        } catch (cause) {
            cue('error');
            setError(authError(cause));
            setPending(false);
        }
    }

    const choosing = mode === 'kit' && !kit;
    return (
        <AuthLayout
            wide
            title={choosing ? 'Use your recovery kit' : 'Choose a new password'}
            description={
                choosing
                    ? 'Your email is confirmed. Your kit shows the account is yours; then you choose a new password.'
                    : 'Resetting gives you a new recovery phrase; you’ll save it next.'
            }
        >
            <form
                noValidate
                aria-busy={pending}
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                }}
            >
                <AuthFields>
                    {error && <AuthNote tone="danger">{error}</AuthNote>}
                    {choosing && (
                        <>
                            {notKit && (
                                <AuthNote tone="danger">
                                    That isn’t a HushOS recovery kit. Choose
                                    hushos-recovery-kit.txt, or type the words.
                                </AuthNote>
                            )}
                            {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- dropping a file is pointer-only; the file input inside is the keyboard way */}
                            <label
                                htmlFor={`${id}-kit`}
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    setOver(true);
                                }}
                                onDragLeave={() => setOver(false)}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    setOver(false);
                                    const file = event.dataTransfer.files[0];
                                    if (file) void read(file);
                                }}
                                className={cn(
                                    'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors has-focus-visible:outline-2 has-focus-visible:outline-ring',
                                    over
                                        ? 'border-primary bg-accent'
                                        : 'border-field hover:bg-muted',
                                )}
                            >
                                <FileTextIcon
                                    className="size-7 text-primary"
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                />
                                <span className="text-[15px] font-semibold">
                                    Use your recovery kit
                                </span>
                                <span className="text-sm">
                                    Drop <span className="font-mono">hushos-recovery-kit.txt</span>{' '}
                                    here or{' '}
                                    <span className="font-semibold text-primary underline underline-offset-4">
                                        choose the file
                                    </span>
                                    .
                                </span>
                                <span className="text-[13px] text-muted-foreground">
                                    It’s read on this device and never uploaded.
                                </span>
                                <input
                                    id={`${id}-kit`}
                                    type="file"
                                    accept=".txt,text/plain"
                                    className="sr-only"
                                    onChange={(event) => {
                                        const file = event.target.files?.[0];
                                        event.target.value = '';
                                        if (file) void read(file);
                                    }}
                                />
                            </label>
                            <button
                                type="button"
                                className={cn(authLink, 'self-center text-sm')}
                                onClick={() => setMode('typing')}
                            >
                                Type the 24 words instead
                            </button>
                        </>
                    )}
                    {mode === 'kit' && kit && (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-wrap items-start justify-between gap-3 rounded-md bg-success-soft px-3.5 py-3 text-sm leading-snug text-success">
                                <span className="flex items-start gap-2.5">
                                    <CircleCheckIcon
                                        className="mt-0.5 size-4 shrink-0"
                                        aria-hidden="true"
                                    />
                                    <span>
                                        <span className="font-semibold">24 of 24 words read</span>{' '}
                                        from <span className="wrap-anywhere">{kit.file}</span>
                                    </span>
                                </span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setKit(null);
                                        setError('');
                                    }}
                                    className="shrink-0 cursor-pointer font-semibold text-foreground underline underline-offset-4"
                                >
                                    Use a different kit
                                </button>
                            </div>
                            <PhraseGrid phrase={kit.words.join(' ')} />
                        </div>
                    )}
                    {mode === 'typing' && (
                        <div className="flex flex-col gap-1.5">
                            <div className="flex items-baseline justify-between">
                                <label
                                    htmlFor={`${id}-words`}
                                    className="text-[13px] font-semibold"
                                >
                                    Recovery phrase
                                </label>
                                <span
                                    className={cn(
                                        'text-[13px] tabular-nums',
                                        count === WORDS ? 'text-success' : 'text-muted-foreground',
                                    )}
                                >
                                    {count} of {WORDS} words
                                </span>
                            </div>
                            <Textarea
                                id={`${id}-words`}
                                autoComplete="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                value={typed}
                                disabled={pending}
                                onChange={(event) => {
                                    setTyped(event.target.value);
                                    setError('');
                                }}
                                aria-invalid={tried && Boolean(errors.typed)}
                                aria-describedby={`${id}-words-note`}
                                className="min-h-24 font-mono text-[15px]"
                            />
                            <p
                                id={`${id}-words-note`}
                                role={tried && errors.typed ? 'alert' : undefined}
                                className={cn(
                                    'text-[13px]',
                                    tried && errors.typed
                                        ? 'text-destructive'
                                        : 'text-muted-foreground',
                                )}
                            >
                                {tried && errors.typed
                                    ? errors.typed
                                    : `All ${WORDS} words, in order.`}
                            </p>
                            <button
                                type="button"
                                className={cn(authLink, 'self-start text-sm')}
                                onClick={() => setMode('kit')}
                            >
                                Use your recovery kit instead
                            </button>
                        </div>
                    )}
                    {ready && (
                        <>
                            <AuthInput
                                label="New password"
                                id={`${id}-password`}
                                type="password"
                                autoComplete="new-password"
                                maxLength={PASSWORD_MAX_LENGTH}
                                value={password}
                                disabled={pending}
                                onChange={(event) => setPassword(event.target.value)}
                                errors={tried && errors.password ? [errors.password] : []}
                            />
                            {!(tried && errors.password) && (
                                <StrengthHint password={password} min={PASSWORD_MIN_LENGTH} />
                            )}
                            <AuthInput
                                label="Confirm new password"
                                id={`${id}-confirm`}
                                type="password"
                                autoComplete="new-password"
                                maxLength={PASSWORD_MAX_LENGTH}
                                value={confirm}
                                disabled={pending}
                                onChange={(event) => setConfirm(event.target.value)}
                                errors={
                                    (tried || confirm.length >= password.length) &&
                                    confirm &&
                                    errors.confirm
                                        ? [errors.confirm]
                                        : []
                                }
                            />
                            <AuthActions
                                action={
                                    <Button type="submit" size="lg" disabled={pending}>
                                        {pending ? 'Resetting…' : 'Reset password'}
                                    </Button>
                                }
                            />
                        </>
                    )}
                </AuthFields>
            </form>
        </AuthLayout>
    );
}
