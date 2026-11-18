/* The line an offset into `text` falls on, counting from 1. */
export function lineAt(text: string, offset: number) {
    let line = 1;
    const end = Math.min(Math.max(offset, 0), text.length);
    for (let at = text.indexOf('\n'); at !== -1 && at < end; at = text.indexOf('\n', at + 1))
        line++;
    return line;
}
