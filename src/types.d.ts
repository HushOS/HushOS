type OpaqueConfig = {
    skU: number;
    pkU: number;
    pkS: number;
    idS: number;
    idU: number;
};

type OpaqueInfos = {
    info: null;
    einfo: null;
};

type OpaqueIds = {
    idS: string;
    idU: string;
};

declare module 'libopaque' {
    const ready: Promise<void>;

    const NotPackaged = 0;
    const InSecEnv = 1;
    const InClrEnv = 2;

    // utils
    function hexToUint8Array(hex: string): Uint8Array;
    function uint8ArrayToHex(uint8Array: Uint8Array): string;

    // server
    function createRegistrationResponse(params: { M: Uint8Array }): {
        sec: Uint8Array;
        pub: Uint8Array;
    };

    function storeUserRecord(params: { sec: Uint8Array; rec: Uint8Array }): { rec: Uint8Array };

    function createCredentialResponse(params: {
        pub: Uint8Array;
        rec: Uint8Array;
        cfg: OpaqueConfig;
        ids: OpaqueIds;
        infos?: OpaqueInfos;
    }): {
        resp: Uint8Array;
        sk: Uint8Array;
        sec: Uint8Array;
    };

    function userAuth(params: { sec: Uint8Array; authU: Uint8Array }): boolean;

    // client
    function createRegistrationRequest(params: { pwdU: string }): {
        M: Uint8Array;
        sec: Uint8Array;
    };

    function finalizeRequest(params: {
        sec: Uint8Array;
        pub: Uint8Array;
        cfg: OpaqueConfig;
        ids: OpaqueIds;
    }): { rec: Uint8Array; export_key: Uint8Array };

    function createCredentialRequest(params: { pwdU: string }): {
        pub: Uint8Array;
        sec: Uint8Array;
    };

    function recoverCredentials(params: {
        resp: Uint8Array;
        sec: Uint8Array;
        cfg: OpaqueConfig;
        ids: OpaqueIds;
        pkS: Uint8Array | null;
        infos?: OpaqueInfos;
    }): { authU: Uint8Array };
}

// declare module 'libopaque/dist/libopaque.debug' {
//     export * from 'libopaque';
// }
