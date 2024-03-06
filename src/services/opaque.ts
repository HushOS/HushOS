import opaque from 'libopaque';

import { expose } from '@/lib/comlink';

export const OpaqueService = {
    createRegistrationRequest: async (password: string) => {
        await opaque.ready;
        const { M, sec } = opaque.createRegistrationRequest({ pwdU: password });

        return {
            mHex: opaque.uint8ArrayToHex(M),
            secHex: opaque.uint8ArrayToHex(sec),
        };
    },

    finalizeRequest: async (secHex: string, response: string, email: string) => {
        await opaque.ready;
        const { export_key, rec } = opaque.finalizeRequest({
            sec: opaque.hexToUint8Array(secHex),
            ids: {
                idS: 'server',
                idU: email,
            },
            pub: opaque.hexToUint8Array(response),
            cfg: {
                idS: 0,
                idU: 0,
                pkS: 0,
                pkU: 0,
                skU: 0,
            },
        });
        return {
            recHex: opaque.uint8ArrayToHex(rec),
            exportKeyHex: opaque.uint8ArrayToHex(export_key),
        };
    },
};

expose(OpaqueService);
