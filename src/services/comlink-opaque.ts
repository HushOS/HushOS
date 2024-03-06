import { Remote, wrap } from '@/lib/comlink';
import { OpaqueService } from '@/services/opaque';

class OpaqueWorker {
    public instance!: Remote<typeof OpaqueService>;

    constructor() {
        if (typeof Worker === 'undefined' || this.instance) {
            return;
        }

        const worker = new Worker(new URL('@/services/opaque', import.meta.url), {
            type: 'module',
            name: 'opaque-worker',
        });

        this.instance = wrap<typeof OpaqueService>(worker);
    }
}

export const OpaqueWorkerInstance = new OpaqueWorker().instance;
