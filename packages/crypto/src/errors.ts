// Only these messages cross the worker boundary; anything else is replaced.
export class CryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CryptoError';
    }
}
