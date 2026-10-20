/* Reads a body as a stream, stopping at the first byte past `limit`: null when it is too large. */
export async function readCapped(request: Request, limit: number) {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader)
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
    }
    return body;
}
