import opaque from 'libopaque';

import { expose } from '@/lib/comlink';
import { getOpaqueIds } from '@/lib/constants';

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
            ids: getOpaqueIds(email),
            pub: opaque.hexToUint8Array(response),
            cfg: {
                idS: 0,
                idU: 0,
                pkS: 1,
                pkU: 0,
                skU: 0,
            },
        });
        return {
            recHex: opaque.uint8ArrayToHex(rec),
            exportKeyHex: opaque.uint8ArrayToHex(export_key),
        };
    },

    createCredentialRequest: async (password: string) => {
        await opaque.ready;
        const { pub, sec } = opaque.createCredentialRequest({ pwdU: password });

        return {
            pubHex: opaque.uint8ArrayToHex(pub),
            secHex: opaque.uint8ArrayToHex(sec),
        };
    },

    recoverCredentials: async (email: string, secHex: string, response: string) => {
        await opaque.ready;
        const { authU } = opaque.recoverCredentials({
            resp: opaque.hexToUint8Array(response),
            sec: opaque.hexToUint8Array(secHex),
            cfg: { idS: 0, idU: 0, pkS: 1, pkU: 0, skU: 0 },
            ids: getOpaqueIds(email),
            pkS: null,
            infos: undefined,
        });

        return { authUHex: opaque.uint8ArrayToHex(authU) };
    },
};

expose(OpaqueService);
