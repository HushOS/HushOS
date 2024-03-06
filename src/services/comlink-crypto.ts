import { Remote, wrap } from '@/lib/comlink';
import { CryptoService } from '@/services/crypto';

class CryptoWorker {
    public instance!: Remote<typeof CryptoService>;

    constructor() {
        if (typeof Worker === 'undefined' || this.instance) {
            return;
        }

        const worker = new Worker(new URL('@/services/crypto', import.meta.url), {
            type: 'module',
            name: 'crypto-worker',
        });

        this.instance = wrap<typeof CryptoService>(worker);
    }
}

export const CryptoWorkerInstance = new CryptoWorker().instance;
