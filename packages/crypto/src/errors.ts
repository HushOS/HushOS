// Only these messages cross the worker boundary; anything else is replaced.
export class CryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CryptoError';
    }
}

/*
 * A request refused before anything in the session changed, such as older
 * keys served than the ones open: the session is as it was, so neither the
 * worker nor the client has reason to start over or lock.
 */
export class RefusedError extends CryptoError {
    constructor(message: string) {
        super(message);
        this.name = 'RefusedError';
    }
}
