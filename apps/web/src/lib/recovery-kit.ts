/*
 * The recovery kit as a file: what downloadKit writes, read back. The phrase
 * sits on the line after "The same phrase on one line"; anything that isn't
 * a kit is refused before a word of it is used.
 */

export const WORDS = 24;

/* The phrase from a kit this app downloaded: the line after "The same phrase on one line". */
export function phraseFromKit(text: string): string[] | null {
    if (!text.trimStart().startsWith('HushOS recovery kit')) return null;
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((line) => line.startsWith('The same phrase on one line'));
    const words = (at >= 0 ? lines[at + 1] : undefined)?.trim().toLowerCase().split(/\s+/) ?? [];
    return words.length === WORDS && words.every((word) => /^[a-z]+$/.test(word)) ? words : null;
}

/*
 * The kit's text: the account, the phrase numbered four to a line (easier to
 * check against a handwritten copy; the order is part of the phrase), the same
 * phrase on one line for pasting and for phraseFromKit, and the wrapped key
 * for recovery tools.
 */
export function kitText(
    account: { email: string; id: string },
    phrase: string,
    recovery: unknown,
    madeOn = new Date(),
) {
    const words = phrase.trim().split(/\s+/);
    const numbered = words.map((word, index) =>
        `${String(index + 1).padStart(2, ' ')}. ${word}`.padEnd(16, ' '),
    );
    const lines: string[] = [];
    for (let i = 0; i < numbered.length; i += 4)
        lines.push(
            numbered
                .slice(i, i + 4)
                .join('')
                .trimEnd(),
        );
    return [
        'HushOS recovery kit',
        `Saved ${madeOn.toISOString().slice(0, 10)}`,
        '',
        'Keep this file private, and keep it somewhere you will find it again.',
        'Anyone who has it can get into your account. If you lose it and forget',
        'your password, nobody can get you back in, including HushOS.',
        '',
        'YOUR ACCOUNT',
        `Email:       ${account.email}`,
        `Account ID:  ${account.id}`,
        '',
        `YOUR RECOVERY PHRASE (${words.length} words, in this order)`,
        'This is what unlocks your account if you forget your password.',
        '',
        ...lines,
        '',
        'The same phrase on one line, for pasting:',
        words.join(' '),
        '',
        'HOW TO USE IT',
        '1. Open HushOS and choose "Forgot your password?".',
        '2. Confirm your email with the link we send.',
        '3. Choose this file when asked for your kit, or type the words above in order.',
        '',
        'WHEN THIS KIT STOPS WORKING',
        'Resetting your password with this phrase, making a new recovery phrase,',
        'or resetting sharing keys in Account makes a new phrase. Save a new kit then.',
        'Changing your password in Account keeps this phrase as it is.',
        '',
        'FOR RECOVERY TOOLS',
        'The block below is your account key, locked with the phrase above. You do',
        'not need it to reset your password in HushOS. It is here so the phrase can',
        'open your key even without the service.',
        '',
        JSON.stringify(recovery, null, 4),
    ].join('\n');
}

export type CheckQuestion = { position: number; options: string[] };

/*
 * Three words to pick back out of the kit, so nobody leaves set-up with a kit
 * they can't read. Three positions, in order, each offered with two other
 * words of the same phrase: someone who saved the words but not their order
 * still has to look.
 */
export function checkQuestions(
    words: readonly string[],
    random: (below: number) => number = randomBelow,
): CheckQuestion[] {
    const positions = new Set<number>();
    while (positions.size < Math.min(3, words.length)) positions.add(random(words.length));
    return [...positions]
        .sort((a, b) => a - b)
        .map((index) => {
            const answer = words[index]!;
            const others = [...new Set(words.filter((word) => word !== answer))];
            const decoys: string[] = [];
            while (decoys.length < Math.min(2, others.length)) {
                const pick = others[random(others.length)]!;
                if (!decoys.includes(pick)) decoys.push(pick);
            }
            const options = [answer, ...decoys];
            // Shuffled, so the answer isn't always first.
            for (let i = options.length - 1; i > 0; i--) {
                const j = random(i + 1);
                [options[i], options[j]] = [options[j]!, options[i]!];
            }
            return { position: index + 1, options };
        });
}

function randomBelow(below: number) {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0]! % below;
}
