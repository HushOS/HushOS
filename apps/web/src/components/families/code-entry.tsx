import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/*
 * Twelve fields for a join code read out by the person letting you in. Typed
 * word by word, or pasted whole into any field: the words are spread across
 * the fields from there. Words are lowercased and trimmed; the data layer
 * checks there are twelve.
 */
export function CodeEntry({
    rosterVersion,
    versionEditable = false,
    pending,
    error,
    onSubmit,
}: {
    rosterVersion: number;
    /*
     * Once someone has been let in, the member list that did it may no longer be the newest:
     * the number on the other person's screen is the one to use, so it can be changed here.
     */
    versionEditable?: boolean;
    pending: boolean;
    error: string;
    onSubmit: (code: string[], rosterVersion: number) => void;
}) {
    const id = useId();
    const [version, setVersion] = useState(String(rosterVersion));
    const [words, setWords] = useState<string[]>(() => Array.from({ length: 12 }, () => ''));
    const fields = useRef<(HTMLInputElement | null)[]>([]);

    // A code that didn't match is typed again from the first word: focus goes there with the reason.
    useEffect(() => {
        if (error) fields.current[0]?.focus();
    }, [error]);

    function set(index: number, value: string) {
        setWords((current) => current.map((word, at) => (at === index ? value : word)));
    }

    function paste(index: number, event: ClipboardEvent<HTMLInputElement>) {
        const parts = event.clipboardData
            .getData('text')
            .trim()
            .split(/[\s,.;]+/)
            .filter(Boolean);
        if (parts.length < 2) return;
        event.preventDefault();
        setWords((current) =>
            current.map((word, at) =>
                at >= index && at - index < parts.length ? parts[at - index]!.toLowerCase() : word,
            ),
        );
        fields.current[Math.min(index + parts.length, 11)]?.focus();
    }

    function submit(event: FormEvent) {
        event.preventDefault();
        onSubmit(
            words.map((word) => word.trim().toLowerCase()),
            versionEditable ? Number(version) : rosterVersion,
        );
    }

    const versionValid = !versionEditable || /^[1-9][0-9]{0,8}$/.test(version.trim());
    const complete = versionValid && words.every((word) => word.trim().length > 0);
    return (
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-[15px] font-semibold">
                    {versionEditable ? 'Join code' : `Join code for member list ${rosterVersion}`}
                </legend>
                {versionEditable && (
                    <div className="mb-2 flex items-center gap-2 text-[13px] text-muted-foreground">
                        <label htmlFor={`${id}-version`}>Member list</label>
                        <Input
                            id={`${id}-version`}
                            inputMode="numeric"
                            autoComplete="off"
                            value={version}
                            onChange={(event) => setVersion(event.target.value)}
                            className="w-24 tabular-nums"
                        />
                    </div>
                )}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {words.map((word, index) => (
                        <label
                            key={index}
                            className="flex items-center gap-2 rounded-md text-[13px] text-muted-foreground"
                        >
                            <span className="w-5 text-right tabular-nums">{index + 1}</span>
                            <Input
                                ref={(node) => {
                                    fields.current[index] = node;
                                }}
                                aria-label={`Word ${index + 1}`}
                                autoComplete="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                value={word}
                                onChange={(event) => set(index, event.target.value)}
                                onPaste={(event) => paste(index, event)}
                                aria-invalid={Boolean(error) || undefined}
                                aria-describedby={`${id}-hint`}
                            />
                        </label>
                    ))}
                </div>
                <p
                    id={`${id}-hint`}
                    role={error ? 'alert' : undefined}
                    className={`text-[13px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}
                >
                    {error ||
                        (versionEditable
                            ? 'Use the member list number on their screen. Pasting all twelve words into the first field works.'
                            : `Check that their screen says member list ${rosterVersion} too. Pasting all twelve words into the first field works.`)}
                </p>
            </fieldset>
            <div className="flex justify-end">
                <Button type="submit" disabled={pending || !complete}>
                    {pending ? 'Saving…' : 'Save join code'}
                </Button>
            </div>
        </form>
    );
}
